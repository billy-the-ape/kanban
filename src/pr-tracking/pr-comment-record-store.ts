// COMMENT-0: durable comment-handling records.
// Kept separate from PRTRACK records: the independently implemented schemas
// are incompatible, and must never write to the same file.
//
// One versioned record per canonical PR identity, stored at
// `<runtimeHome>/pr-tracking/comments/<sha256(canonicalPrKey)>.json`. Records are
// mutated only through revision-checked atomic updates serialized by the
// comment-record mutex. The mutex is never held while awaiting
// network or model work.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeGitHubPrTrackingRecord, RuntimeTaskPullRequest } from "../core/api-contract";
import { runtimeGitHubPrTrackingRecordSchema } from "../core/api-contract";
import { getRuntimeHomePath } from "../state/workspace-state";

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export function getPrTrackingRecordsDirPath(): string {
	return join(getRuntimeHomePath(), "pr-tracking", "comments");
}

export function getPrTrackingRecordPath(canonicalPrKey: string): string {
	return join(getPrTrackingRecordsDirPath(), `${sha256Hex(canonicalPrKey)}.json`);
}

/**
 * The comment-record mutex. All record/reservation changes for all
 * PRs serialize through this queue. Callers must release it (by returning)
 * before acquiring task/Git locks or awaiting network/model work.
 */
let registryLockTail: Promise<void> = Promise.resolve();

function withPrTrackingRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
	const next = registryLockTail.then(operation);
	registryLockTail = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export type PrTrackingRecordLoadResult =
	| { status: "missing" }
	| { status: "malformed"; error: string }
	| { status: "ok"; record: RuntimeGitHubPrTrackingRecord };

async function readPrTrackingRecordFile(path: string, expectedKey: string | null): Promise<PrTrackingRecordLoadResult> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return { status: "missing" };
		}
		return { status: "malformed", error: `Could not read PR tracking record: ${String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: "malformed", error: `Malformed JSON in PR tracking record: ${message}` };
	}
	const result = runtimeGitHubPrTrackingRecordSchema.safeParse(parsed);
	if (!result.success) {
		const firstIssue = result.error.issues[0];
		const location = firstIssue && firstIssue.path.length > 0 ? firstIssue.path.join(".") : "root";
		const message = firstIssue ? firstIssue.message : "unknown schema issue";
		return { status: "malformed", error: `PR tracking record failed validation at ${location}: ${message}` };
	}
	// Validate the composite identity against the record contents when the
	// expected key is known; a mismatch is a malformed record, not a crash.
	if (expectedKey !== null && result.data.canonicalPrKey !== expectedKey) {
		return { status: "malformed", error: "PR tracking record identity does not match its storage key." };
	}
	return { status: "ok", record: result.data };
}

export function createInitialPrTrackingRecord(input: {
	canonicalPrKey: string;
	accessScopeId: string;
	pr: RuntimeTaskPullRequest;
}): RuntimeGitHubPrTrackingRecord {
	return {
		schemaVersion: 1,
		revision: 0,
		canonicalPrKey: input.canonicalPrKey,
		accessScopeId: input.accessScopeId,
		pr: input.pr,
		taskBindings: [],
		commentAutomation: {
			repairOwner: null,
			pendingFeedbackFingerprint: null,
			pendingCount: null,
			debounceDeadline: null,
			firstPendingAt: null,
			lastDispatchedFeedbackFingerprint: null,
			dispatch: null,
		},
	};
}

/**
 * Loads a record by canonical PR key. Malformed/unsupported records block
 * tracking for that PR; they never create subscriptions or crash polling.
 */
export async function loadPrTrackingRecord(canonicalPrKey: string): Promise<PrTrackingRecordLoadResult> {
	return await withPrTrackingRegistryLock(() =>
		readPrTrackingRecordFile(getPrTrackingRecordPath(canonicalPrKey), canonicalPrKey),
	);
}

/**
 * All durable records on disk (used for restart reconciliation). Malformed
 * files are skipped and reported, never fatal.
 */
export async function listPrTrackingRecords(): Promise<RuntimeGitHubPrTrackingRecord[]> {
	let entries: string[];
	try {
		entries = await readdir(getPrTrackingRecordsDirPath());
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return [];
		}
		return [];
	}
	const records: RuntimeGitHubPrTrackingRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const result = await readPrTrackingRecordFile(join(getPrTrackingRecordsDirPath(), entry), null);
		if (result.status === "ok") {
			records.push(result.record);
		}
	}
	return records;
}

/**
 * Applies a revision-checked atomic update to one record (creating it when
 * missing). The mutator must return the same record (no revision bump) to
 * skip the write, or a record with exactly `revision + 1` to persist it.
 */
export async function upsertPrTrackingRecord(
	canonicalPrKey: string,
	identity: { accessScopeId: string; pr: RuntimeTaskPullRequest },
	mutator: (record: RuntimeGitHubPrTrackingRecord) => RuntimeGitHubPrTrackingRecord,
): Promise<RuntimeGitHubPrTrackingRecord> {
	return await withPrTrackingRegistryLock(async () => {
		const path = getPrTrackingRecordPath(canonicalPrKey);
		const existing = await readPrTrackingRecordFile(path, canonicalPrKey);
		if (existing.status === "malformed") {
			throw new Error(`Cannot update PR tracking record (malformed): ${existing.error}`);
		}
		const base =
			existing.status === "ok"
				? existing.record
				: createInitialPrTrackingRecord({ canonicalPrKey, accessScopeId: identity.accessScopeId, pr: identity.pr });
		const next = mutator(base);
		if (next.revision === base.revision) {
			return next;
		}
		if (next.revision !== base.revision + 1) {
			throw new Error(
				`PR tracking record revision must advance by exactly one (got ${base.revision} -> ${next.revision}).`,
			);
		}
		await mkdir(dirname(path), { recursive: true });
		const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(tmpPath, path);
		return next;
	});
}
