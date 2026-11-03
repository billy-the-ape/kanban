// AM-1: durable auto-merge policy store.
//
// One small versioned policy per normalized canonical GitHub `owner/repo`
// is persisted at `<runtimeHome>/auto-merge/policies.json` inside the
// existing runtime-home backup scope. Reads are fail-closed: a missing or
// malformed store yields "no policy" (auto-merge stays disabled, no crash,
// no migration). Writes are serialized by a file lock on the policy file
// and are revision-checked (CAS) per repository: a stale `expectedRevision`
// never overwrites a newer policy.
//
// The stored policy is the ONLY machine-merge configuration: an explicit
// nonempty set of exact GitHub check names and a merge method. No tokens
// or credentials are stored here, and no GitHub reads or writes happen in
// this module.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AutoMergePolicy, AutoMergePolicyMergeMethod } from "../core/api-contract";
import { autoMergePolicySchema } from "../core/api-contract";
import type { LockRequest } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

const AUTO_MERGE_DIR_NAME = "auto-merge";
const POLICIES_FILENAME = "policies.json";
const POLICY_FILE_VERSION = 1;
/** Bound the store: at most this many configured checks per repository. */
const MAX_REQUIRED_CHECKS = 100;
const MAX_CHECK_LENGTH = 300;
const MAX_REPOSITORY_SEGMENT_LENGTH = 100;

const REPOSITORY_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface AutoMergePolicyFile {
	version: number;
	policies: Record<string, AutoMergePolicy>;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Normalize a caller-supplied repository identity to the canonical lowercase
 * `owner/repo` key. Returns null for anything that is not exactly two
 * alphanumeric GitHub-style segments (no glob characters, no nested groups,
 * no hosts). The policy store is keyed by this exact key.
 */
export function normalizeAutoMergeRepository(repository: string): string | null {
	const trimmed = repository.trim().toLowerCase();
	const segments = trimmed.split("/");
	if (segments.length !== 2) {
		return null;
	}
	for (const segment of segments) {
		if (segment.length > MAX_REPOSITORY_SEGMENT_LENGTH || !REPOSITORY_SEGMENT_PATTERN.test(segment)) {
			return null;
		}
	}
	return trimmed;
}

/**
 * Validate and normalize the configured check names: trimmed, case-sensitive
 * exact GitHub check-run names. Rejects empty lists, whitespace/glob
 * patterns, over-long names, and more than MAX_REQUIRED_CHECKS entries.
 * Duplicate names are deduped (first occurrence wins). Returns null when the
 * input does not describe a valid nonempty policy.
 */
export function validateRequiredChecks(checks: string[]): string[] | null {
	if (checks.length === 0 || checks.length > MAX_REQUIRED_CHECKS) {
		return null;
	}
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const check of checks) {
		const trimmed = check.trim();
		if (trimmed.length === 0 || trimmed.length > MAX_CHECK_LENGTH) {
			return null;
		}
		// No glob patterns, no vague multi-word workflow descriptions.
		if (trimmed.includes("*") || trimmed.includes("?") || /\s/.test(trimmed)) {
			return null;
		}
		if (seen.has(trimmed)) {
			// Duplicates are dropped (first occurrence wins).
			continue;
		}
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function parsePolicyFile(raw: string): AutoMergePolicyFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const file = parsed as { version?: unknown; policies?: unknown };
	if (file.version !== POLICY_FILE_VERSION || typeof file.policies !== "object" || file.policies === null) {
		return null;
	}
	const policies: Record<string, AutoMergePolicy> = {};
	for (const [repository, rawPolicy] of Object.entries(file.policies)) {
		const policy = autoMergePolicySchema.safeParse(rawPolicy);
		if (!policy.success || policy.data.repository !== repository) {
			return null;
		}
		policies[repository] = policy.data;
	}
	return { version: POLICY_FILE_VERSION, policies };
}

export type AutoMergePolicyUpdateResult =
	| { ok: true; policy: AutoMergePolicy }
	| { ok: false; reason: "invalid" | "conflict" | "malformed" };

export interface AutoMergePolicyStoreOptions {
	/** Override the automation storage root (tests). Defaults to the runtime home. */
	rootPath?: string;
	now?: () => number;
}

export interface AutoMergePolicyUpdateInput {
	requiredChecks: string[];
	/** Defaults to "merge" when omitted. */
	mergeMethod?: AutoMergePolicyMergeMethod;
}

type PrivatePolicyState =
	| { state: "absent" }
	| { state: "malformed" }
	| { state: "present"; file: AutoMergePolicyFile };

export class AutoMergePolicyStore {
	private readonly rootPath: string;
	private readonly now: () => number;

	constructor(options: AutoMergePolicyStoreOptions = {}) {
		this.rootPath = options.rootPath ?? getRuntimeHomePath();
		this.now = options.now ?? Date.now;
	}

	get policiesPath(): string {
		return join(this.rootPath, AUTO_MERGE_DIR_NAME, POLICIES_FILENAME);
	}

	private lockRequest(): LockRequest {
		return {
			path: this.policiesPath,
			type: "file",
		};
	}

	private async readPolicyState(): Promise<PrivatePolicyState> {
		let raw: string;
		try {
			raw = await readFile(this.policiesPath, "utf8");
		} catch (error) {
			if (isNodeErrorWithCode(error, "ENOENT")) {
				return { state: "absent" };
			}
			throw error;
		}
		const file = parsePolicyFile(raw);
		return file ? { state: "present", file } : { state: "malformed" };
	}

	/**
	 * Load the policy for one normalized repository. Missing file, missing
	 * entry, or malformed file all read as "no policy" (fail closed).
	 */
	async loadPolicy(repository: string): Promise<AutoMergePolicy | null> {
		const normalized = normalizeAutoMergeRepository(repository);
		if (!normalized) {
			return null;
		}
		const state = await this.readPolicyState();
		if (state.state !== "present") {
			return null;
		}
		return state.file.policies[normalized] ?? null;
	}

	/**
	 * Create or replace the policy for one normalized repository.
	 * `expectedRevision` is a CAS guard: it must equal the stored revision
	 * (a missing policy reads as 0). Validation failures, a stale revision,
	 * and a malformed store file all fail without writing.
	 */
	async updatePolicy(
		repository: string,
		input: AutoMergePolicyUpdateInput,
		expectedRevision: number | undefined,
	): Promise<AutoMergePolicyUpdateResult> {
		const normalized = normalizeAutoMergeRepository(repository);
		if (!normalized) {
			return { ok: false, reason: "invalid" };
		}
		const requiredChecks = validateRequiredChecks(input.requiredChecks);
		if (!requiredChecks) {
			return { ok: false, reason: "invalid" };
		}
		const mergeMethod: AutoMergePolicyMergeMethod = input.mergeMethod ?? "merge";
		return await lockedFileSystem.withLock(this.lockRequest(), async () => {
			const state = await this.readPolicyState();
			if (state.state === "malformed") {
				// A corrupt store must not be clobbered: surface it instead.
				return { ok: false, reason: "malformed" } satisfies AutoMergePolicyUpdateResult;
			}
			const current = state.state === "present" ? state.file.policies[normalized] : undefined;
			const currentRevision = current?.revision ?? 0;
			if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
				return { ok: false, reason: "conflict" } satisfies AutoMergePolicyUpdateResult;
			}
			const policy: AutoMergePolicy = {
				repository: normalized,
				requiredChecks,
				mergeMethod,
				revision: currentRevision + 1,
				updatedAt: this.now(),
			};
			const file: AutoMergePolicyFile = {
				version: POLICY_FILE_VERSION,
				policies: {
					...(state.state === "present" ? state.file.policies : {}),
					[normalized]: policy,
				},
			};
			await lockedFileSystem.writeJsonFileAtomic(this.policiesPath, file, { lock: null });
			return { ok: true, policy } satisfies AutoMergePolicyUpdateResult;
		});
	}
}
