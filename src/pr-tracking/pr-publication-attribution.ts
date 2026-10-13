// COMMENT-0: publication attribution for implementation-agent PR writes.
//
// Pure detection + identity extraction over implementation task tool calls.
// Only recognized write operations are considered, and identities come
// exclusively from attributable API responses or returned comment/review
// URLs — never from command text, quoted reply bodies, read-only output, or
// arbitrary URLs in a mixed tool result. The result is publication
// attribution metadata (which exact identities the implementation session
// published), not a ledger of feedback fixes, decisions, or repair outcomes.
//
// Known limitation (documented, not hidden): arbitrary opaque scripts or
// deliberately suppressed output cannot be exhaustively attributed while
// preserving unrestricted terminal access. Those cases surface as an
// explicit capture uncertainty instead of silently registering (or missing)
// identities.
import { splitCommandFragments, tokenizeCommandFragment } from "../core/pull-request-detection";

export type PrPublishedIdentityKind = "conversation" | "inline" | "review";

/** One implementation-published GitHub feedback item (kind + database id). */
export interface PrPublishedIdentity {
	kind: PrPublishedIdentityKind;
	id: number;
}

/** Namespaced identity string matching the feedback event provider ids. */
export function prPublishedIdentityKey(identity: PrPublishedIdentity): string {
	return `${identity.kind}-${identity.id}`;
}

/** A github.com PR selection target (matches RuntimeTaskPullRequest fields). */
export interface PrPublicationTarget {
	host: string;
	/** "owner/repo". */
	repository: string;
	number: number;
}

/** A recognized PR-feedback write operation in one command fragment. */
export interface PrPublicationOperation {
	/** Minimal label for attribution: "gh pr comment" | "gh api" | "gh pr review". */
	operation: string;
	/**
	 * The feedback kind the write produces, or null for a write-looking
	 * `gh api` call whose endpoint cannot be attributed to a comment,
	 * review, or inline reply: it is a recognized publication whose output
	 * can never yield identities (always an uncertain capture).
	 */
	kind: PrPublishedIdentityKind | null;
	explicitRepository: string | null;
	explicitNumber: number | null;
	/** The command fragment that produced this operation (ties output to the write). */
	fragment: string;
}

export type PrPublicationStatus = "none" | "pending" | "published" | "failed" | "uncertain";

export interface PrPublicationObservation {
	/**
	 * none: no recognized write operation; pending: recognized write before
	 * execution (started phase, output not yet available); published:
	 * identities captured; failed: the write clearly failed (nothing
	 * published); uncertain: a write happened (or may have) and the exact
	 * identity cannot be established from the available evidence.
	 */
	status: PrPublicationStatus;
	/** The linked PR this operation resolved to, when determinable. */
	target: PrPublicationTarget | null;
	/**
	 * True when every operation carried an explicit selector (repository
	 * and/or PR number, including the endpoint of a `gh api` write) that
	 * matches no linked PR: the write demonstrably targets another PR, so
	 * this task's automation is unaffected. An ambiguous selector
	 * (unparseable or matching nothing without being explicit) leaves
	 * `target` null WITHOUT this flag: every linked PR must be treated as
	 * an uncertain capture.
	 */
	explicitUnlinked: boolean;
	operation: string | null;
	kind: PrPublishedIdentityKind | null;
	identities: PrPublishedIdentity[];
	/** Human-readable uncertainty reason (visible in the panel). */
	reason: string | null;
}

const GH_API_WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** Flags whose next token is a value (skipped when scanning for positionals). */
const GH_VALUE_FLAGS = new Set([
	"-b",
	"--body",
	"--body-file",
	"-R",
	"--repo",
	"-l",
	"--label",
	"--reviewer",
	"--milestone",
	"--project",
]);
/** `gh api` flags whose next token is a value. */
const GH_API_VALUE_FLAGS = new Set([
	"-f",
	"-F",
	"-H",
	"--field",
	"--raw-field",
	"--header",
	"--input",
	"--jq",
	"-q",
	"--hostname",
	"-t",
	"--template",
	"--cache",
	"--method",
	"-X",
	"-p",
	"--preview",
]);
/** `gh api` payload flags: their presence implies a POST when no method is given. */
const GH_API_PAYLOAD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

function isDigits(value: string): boolean {
	return value.length > 0 && /^\d+$/.test(value);
}

/**
 * Scans one fragment for a `-R/--repo <owner/repo>` or a positional PR
 * number. A bare digits token is a PR number only when it directly follows
 * the action (before any flag) or is the sole positional after value flags.
 */
function readPrSelection(tokens: string[], from: number): { repository: string | null; number: number | null } {
	let repository: string | null = null;
	let number: number | null = null;
	for (let i = from; i < tokens.length; i += 1) {
		const token = tokens[i] ?? "";
		if (token === "-R" || token === "--repo") {
			repository = tokens[i + 1] ?? repository;
			i += 1;
			continue;
		}
		if (GH_VALUE_FLAGS.has(token)) {
			i += 1;
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		if (isDigits(token) && number === null) {
			number = Number.parseInt(token, 10);
		}
	}
	return { repository, number };
}

function parseApiWriteEndpoint(endpoint: string): { kind: PrPublishedIdentityKind } | null {
	// REST write endpoints for PR feedback:
	//   repos/O/R/issues/N/comments[?/C]   conversation comment create/edit
	//   repos/O/R/pulls/N/comments[?/C]     inline (review) comment create/edit
	//   repos/O/R/pulls/N/reviews           review submission (may carry inlines)
	// `gh api` accepts a leading slash, so normalize before matching.
	const normalized = endpoint.replace(/^\/+/, "");
	// In-thread replies use `.../comments/<id>/replies` (still inline kind).
	const match = /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)\/comments(?:\/\d+(?:\/replies)?)?$/.exec(normalized);
	if (match) {
		return { kind: match[3] === "issues" ? "conversation" : "inline" };
	}
	const reviews = /^repos\/([^/]+)\/([^/]+)\/(pulls)\/(\d+)\/(reviews)$/.exec(normalized);
	if (reviews) {
		return { kind: "review" };
	}
	return null;
}

/**
 * Detects recognized PR-feedback write operations in raw command strings.
 * Pure string scan (cheap enough to run for every tool call); returns
 * operations in first-appearance order, deduplicated by shape. `--web`
 * variants open a browser instead of an API write and are not publications.
 */
export function detectPublicationOperations(commands: string[]): PrPublicationOperation[] {
	const operations: PrPublicationOperation[] = [];
	const seen = new Set<string>();
	const push = (operation: PrPublicationOperation): void => {
		const shape = `${operation.operation}|${operation.kind}|${operation.explicitRepository}|${operation.explicitNumber}|${operation.fragment}`;
		if (seen.has(shape)) {
			return;
		}
		seen.add(shape);
		operations.push(operation);
	};
	for (const command of commands) {
		for (const fragment of splitCommandFragments(command)) {
			const tokens = tokenizeCommandFragment(fragment);
			const commandName = tokens[0] ?? "";
			if (commandName !== "gh") {
				continue;
			}
			const group = tokens[1] ?? "";
			if (group === "pr") {
				const action = tokens[2] ?? "";
				if (action === "comment") {
					if (tokens.slice(3).includes("--web")) {
						continue;
					}
					const selection = readPrSelection(tokens, 3);
					push({
						operation: "gh pr comment",
						kind: "conversation",
						explicitRepository: selection.repository,
						explicitNumber: selection.number,
						fragment,
					});
				} else if (action === "review" && tokens.slice(3).includes("--comment")) {
					if (tokens.slice(3).includes("--web")) {
						continue;
					}
					const selection = readPrSelection(tokens, 3);
					push({
						operation: "gh pr review",
						kind: "review",
						explicitRepository: selection.repository,
						explicitNumber: selection.number,
						fragment,
					});
				}
			} else if (group === "api") {
				let i = 2;
				let method: string | null = null;
				let hasPayload = false;
				let endpoint: string | null = null;
				// `gh api [METHOD] ENDPOINT [flags]`: real gh takes the method
				// via flags, so scan from the token after "api".
				while (i < tokens.length) {
					const token = tokens[i] ?? "";
					if (token.startsWith("--") && token.includes("=")) {
						// `--flag=value` form: consumes itself.
						if (token.startsWith("--method=")) {
							method = token.slice("--method=".length).toUpperCase();
						}
						i += 1;
						continue;
					}
					if (token === "-X" || token === "--method") {
						method = (tokens[i + 1] ?? "").toUpperCase() || method;
						i += 2;
						continue;
					}
					if (token.startsWith("-X") && token.length > 2) {
						method = token.slice(2).toUpperCase();
						i += 1;
						continue;
					}
					if (GH_API_VALUE_FLAGS.has(token)) {
						if (GH_API_PAYLOAD_FLAGS.has(token)) {
							hasPayload = true;
						}
						i += 2;
						continue;
					}
					if (token.startsWith("-")) {
						// Valueless flags (`--paginate`, `--silent`, `--slurp`, `--help`, ...).
						i += 1;
						continue;
					}
					if (endpoint === null) {
						endpoint = token;
					}
					i += 1;
				}
				const effective = method ?? (hasPayload ? "POST" : "GET");
				if (!endpoint || !GH_API_WRITE_METHODS.has(effective)) {
					continue;
				}
				const normalizedEndpoint = endpoint.replace(/^\/+/, "");
				const parsed = parseApiWriteEndpoint(normalizedEndpoint);
				const repoMatch = /^repos\/([^/]+)\/([^/]+)/.exec(normalizedEndpoint);
				const numberMatch = /\/(\d+)\/(comments|reviews)/.exec(normalizedEndpoint);
				if (!parsed) {
					// A write-looking `gh api` call whose endpoint does not
					// match a known PR-feedback shape: a recognized
					// publication whose output can never be attributed
					// (kind null) — never silently dropped.
					push({
						operation: "gh api",
						kind: null,
						explicitRepository: repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : null,
						explicitNumber: numberMatch ? Number.parseInt(numberMatch[1], 10) : null,
						fragment,
					});
					continue;
				}
				push({
					operation: "gh api",
					kind: parsed.kind,
					explicitRepository: repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : null,
					explicitNumber: numberMatch ? Number.parseInt(numberMatch[1], 10) : null,
					fragment,
				});
			}
		}
	}
	return operations;
}

function sameTarget(left: PrPublicationTarget | null, right: PrPublicationTarget | null): boolean {
	return (
		left !== null &&
		right !== null &&
		left.host === right.host &&
		// GitHub treats owner/repo case-insensitively.
		left.repository.toLowerCase() === right.repository.toLowerCase() &&
		left.number === right.number
	);
}

function matchLinked(
	linked: PrPublicationTarget[],
	repository: string | null,
	number: number | null,
): PrPublicationTarget | null {
	// GitHub treats owner/repo case-insensitively; linked repositories keep
	// the case of the pasted URL.
	const repo = repository === null ? null : repository.toLowerCase();
	if (repo !== null && number !== null) {
		const match = linked.find((target) => target.repository.toLowerCase() === repo && target.number === number);
		return match ?? null;
	}
	if (repo !== null) {
		const onRepo = linked.filter((target) => target.repository.toLowerCase() === repo);
		return onRepo.length === 1 ? onRepo[0] : null;
	}
	if (number !== null) {
		const byNumber = linked.filter((target) => target.number === number);
		return byNumber.length === 1 ? byNumber[0] : null;
	}
	// No explicit selector: only safe with exactly one linked PR (the
	// command's implicit selector targets that PR's branch).
	return linked.length === 1 ? linked[0] : null;
}

/**
 * True when every operation explicitly selected a target (repository and/or
 * number) and none of those explicit selections matches a linked PR.
 */
function isExplicitUnlinked(operations: PrPublicationOperation[], linked: PrPublicationTarget[]): boolean {
	return operations.every(
		(operation) =>
			(operation.explicitRepository !== null || operation.explicitNumber !== null) &&
			matchLinked(linked, operation.explicitRepository, operation.explicitNumber) === null,
	);
}

/**
 * Resolves the single tracked PR a tool call's write operations target.
 * Every operation must resolve to the same linked PR; otherwise the
 * publication cannot be attributed to one tracking record.
 */
export function resolvePublicationTarget(
	operations: PrPublicationOperation[],
	linked: PrPublicationTarget[],
): PrPublicationTarget | null {
	if (operations.length === 0) {
		return null;
	}
	const resolved = operations.map((operation) =>
		matchLinked(linked, operation.explicitRepository, operation.explicitNumber),
	);
	if (resolved.some((target) => target === null)) {
		return null;
	}
	return resolved.every((target) => sameTarget(target, resolved[0])) ? resolved[0] : null;
}
export interface PrPublicationOutputResult {
	status: "published" | "failed" | "uncertain";
	identities: PrPublishedIdentity[];
	reason: string | null;
}

function findBalancedBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const char = text[i] ?? "";
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

/** Top-level JSON objects embedded in tool output (parse failures skipped). */
function extractJsonObjects(text: string): Array<Record<string, unknown>> {
	const results: Array<Record<string, unknown>> = [];
	for (let i = 0; i < text.length && results.length < 8; i += 1) {
		if (text[i] !== "{") {
			continue;
		}
		const end = findBalancedBrace(text, i);
		if (end < 0) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(text.slice(i, end + 1));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				results.push(parsed as Record<string, unknown>);
			}
		} catch {
			// Not a JSON document; keep scanning.
		}
		i = end;
	}
	return results;
}

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function readPositiveInt(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Maps one attributable GitHub API response object to published identities.
 * The object must carry the target repository/PR in its URL fields; error
 * responses (`{"message": ...}` with no id) are recognized as failures.
 */
function mapApiResponseIdentity(
	object: Record<string, unknown>,
	target: PrPublicationTarget | null,
): { kind: "identities" | "error"; identities: PrPublishedIdentity[] } {
	if (target === null) {
		return { kind: "identities", identities: [] };
	}
	const id = readPositiveInt(object, "id");
	// Prefer html_url: the `url` field of an API comment object is a
	// comment endpoint URL (`.../issues/comments/<id>`) that does not carry
	// the PR number.
	const url = readString(object, "html_url") ?? readString(object, "url");
	const issueUrl = readString(object, "issue_url");
	const pullRequestUrl = readString(object, "pull_request_url");
	const path = object.path;
	const diffHunk = object.diff_hunk;
	const state = object.state;
	const hasTarget = (value: string | null): boolean => {
		if (!value) {
			return false;
		}
		// Handles both `https://github.com/O/R/...` and
		// `https://api.github.com/repos/O/R/...` URL forms.
		const repoMatch = /(?:api\.)?github\.com(?:\/repos)?\/([^/\s?#]+)\/([^/\s?#]+)/.exec(value);
		const repo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : null;
		const numberMatch = /(?:\/pull|\/pulls|\/issues)\/(\d+)/.exec(value);
		const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : null;
		// GitHub treats owner/repo case-insensitively.
		return repo !== null && repo.toLowerCase() === target.repository.toLowerCase() && number === target.number;
	};
	if (id === null) {
		// API error response (or something without an identity).
		return { kind: typeof object.message === "string" ? "error" : "identities", identities: [] };
	}
	if (issueUrl !== null && hasTarget(issueUrl) && (url === null || hasTarget(url))) {
		return { kind: "identities", identities: [{ kind: "conversation", id }] };
	}
	if (pullRequestUrl !== null && hasTarget(pullRequestUrl)) {
		if (path !== undefined && diffHunk !== undefined) {
			return { kind: "identities", identities: [{ kind: "inline", id }] };
		}
		if (typeof state === "string") {
			// A submitted review response: the review itself plus every
			// inline comment it returned. Real `POST /pulls/N/reviews`
			// responses carry no `comments` array, so it is optional.
			const identities: PrPublishedIdentity[] = [{ kind: "review", id }];
			const comments = object.comments;
			if (Array.isArray(comments)) {
				for (const comment of comments) {
					if (comment !== null && typeof comment === "object" && !Array.isArray(comment)) {
						const commentId = readPositiveInt(comment as Record<string, unknown>, "id");
						if (commentId !== null) {
							identities.push({ kind: "inline", id: commentId });
						}
					}
				}
			}
			return { kind: "identities", identities };
		}
	}
	// A URL for the target PR but an unrecognized shape: do not guess.
	return { kind: "identities", identities: [] };
}

/**
 * Returns comment/review URLs printed by `gh pr comment` / `gh pr review`,
 * validated against the target PR. The fragment anchors are the GitHub
 * database ids (`#issuecomment-<issue comment id>`, `#discussion_r<review
 * comment id>`, `#pullrequestreview-<review id>`), so each form is only
 * accepted under its own kind — a reviewer's inline URL never registers as
 * a conversation identity or vice versa.
 */
function extractUrlIdentities(
	text: string,
	operations: PrPublicationOperation[],
	target: PrPublicationTarget | null,
): PrPublishedIdentity[] {
	if (target === null) {
		return [];
	}
	const identities: PrPublishedIdentity[] = [];
	const kinds = new Set(
		operations.map((operation) => operation.kind).filter((kind): kind is PrPublishedIdentityKind => kind !== null),
	);
	if (kinds.has("conversation")) {
		const pattern = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/discussions\/|#issuecomment-)(\d+)/g;
		for (const match of text.matchAll(pattern)) {
			if (
				match[1] === target.host &&
				`${match[2]}/${match[3]}`.toLowerCase() === target.repository.toLowerCase() &&
				Number.parseInt(match[4], 10) === target.number
			) {
				identities.push({ kind: "conversation", id: Number.parseInt(match[5], 10) });
			}
		}
	}
	if (kinds.has("inline")) {
		const pattern = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)#discussion_r(\d+)/g;
		for (const match of text.matchAll(pattern)) {
			if (
				match[1] === target.host &&
				`${match[2]}/${match[3]}`.toLowerCase() === target.repository.toLowerCase() &&
				Number.parseInt(match[4], 10) === target.number
			) {
				identities.push({ kind: "inline", id: Number.parseInt(match[5], 10) });
			}
		}
	}
	if (kinds.has("review")) {
		const pattern = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:#pullrequestreview-|\/reviews\/)(\d+)/g;
		for (const match of text.matchAll(pattern)) {
			if (
				match[1] === target.host &&
				`${match[2]}/${match[3]}`.toLowerCase() === target.repository.toLowerCase() &&
				Number.parseInt(match[4], 10) === target.number
			) {
				identities.push({ kind: "review", id: Number.parseInt(match[5], 10) });
			}
		}
	}
	return identities;
}

function hasClearFailureEvidence(output: string | null, error: string | null): boolean {
	const candidates = [output, error].filter((value): value is string => value !== null && value.trim().length > 0);
	if (candidates.length === 0) {
		return false;
	}
	const pattern = /^\s*gh: |^HTTP [45]\d\d|^\s*HTTP [45]\d\d|GraphQL/i;
	return candidates.some((value) => pattern.test(value));
}

/** A Cline command-tool structured result entry: `{query, result, success}`. */
function isCommandResultEntry(object: Record<string, unknown>): boolean {
	return typeof object.query === "string" && typeof object.success === "boolean" && "result" in object;
}

const MULTI_OBJECT_UNCERTAINTY_REASON =
	"The output contained several GitHub objects; the published identity could not be confirmed.";

/**
 * Resolves a recognized write's tool output to exact published identities.
 * Identities come only from attributable API responses or returned URLs for
 * the resolved target, tied to the write invocation: when the output is a
 * structured per-fragment command result, only the result(s) whose query is
 * a write fragment contribute, so a read fragment in the same tool call can
 * never register identities. Several identity-bearing objects in the
 * evidence (a listing mixed into the write's output) can never register —
 * it is explicit uncertainty, never a guess. A clear API/CLI failure means
 * nothing was published; anything else is explicit uncertainty.
 */
export function resolvePublicationOutput(input: {
	operations: PrPublicationOperation[];
	target: PrPublicationTarget | null;
	output: string | null;
	error: string | null;
}): PrPublicationOutputResult {
	const text = input.output ?? "";
	const writeFragments = input.operations
		.map((operation) => operation.fragment)
		.filter((fragment) => fragment.length > 0);
	// Scope the evidence to the write fragment(s). A structured per-fragment
	// result array reduces to the write fragment's own result(s); plain
	// output is used as-is (also the restart-recovery path, where the
	// fragment is not known and the multi-object guard below still applies).
	const entries = extractJsonObjects(text).filter(isCommandResultEntry);
	const matched =
		entries.length > 0 && writeFragments.length > 0
			? entries.filter((entry) => {
					const query = typeof entry.query === "string" ? entry.query : "";
					// The entry's query must contain the write fragment: a read
					// fragment that prefixes the write must not contribute.
					return writeFragments.some((fragment) => query.includes(fragment));
				})
			: [];
	const candidateTexts: string[] = [];
	for (const entry of matched) {
		const result = entry.result;
		if (typeof result === "string") {
			candidateTexts.push(result);
		} else if (result !== null && typeof result === "object") {
			candidateTexts.push(JSON.stringify(result));
		}
	}
	if (candidateTexts.length === 0) {
		candidateTexts.push(text);
	}
	const collected: PrPublishedIdentity[] = [];
	let sawError = false;
	let identityObjects = 0;
	let totalObjects = 0;
	for (const candidate of candidateTexts) {
		const objects = extractJsonObjects(candidate);
		totalObjects += objects.length;
		for (const object of objects) {
			const mapped = mapApiResponseIdentity(object, input.target);
			if (mapped.kind === "error") {
				sawError = true;
				continue;
			}
			if (mapped.identities.length > 0) {
				// One identity-bearing object per write operation: a listing
				// (several objects) is never registered.
				identityObjects += 1;
				collected.push(...mapped.identities);
			}
		}
	}
	if (identityObjects > 1) {
		return { status: "uncertain", identities: [], reason: MULTI_OBJECT_UNCERTAINTY_REASON };
	}
	if (collected.length === 0) {
		// A multi-object output that yielded no identities is not safe for
		// the URL fallback (a listing's URLs are not the write's).
		if (totalObjects > 1) {
			return { status: "uncertain", identities: [], reason: MULTI_OBJECT_UNCERTAINTY_REASON };
		}
		for (const candidate of candidateTexts) {
			collected.push(...extractUrlIdentities(candidate, input.operations, input.target));
		}
	}
	const deduped: PrPublishedIdentity[] = [];
	const seen = new Set<string>();
	for (const identity of collected) {
		const key = prPublishedIdentityKey(identity);
		if (!seen.has(key)) {
			seen.add(key);
			deduped.push(identity);
		}
	}
	if (deduped.length > 0) {
		return { status: "published", identities: deduped, reason: null };
	}
	if (sawError || hasClearFailureEvidence(input.output, input.error)) {
		return { status: "failed", identities: [], reason: null };
	}
	return {
		status: "uncertain",
		identities: [],
		reason: "The publication output did not include the comment or review identity.",
	};
}

/**
 * Analyzes one implementation tool call for PR-feedback publications.
 * `output` null = started phase (recognized write, execution not yet
 * complete): establishes capture-pending without any identity claim.
 */
export function analyzePrPublication(input: {
	toolName: string | null;
	commands: string[];
	output: string | null;
	error: string | null;
	linkedPullRequests: PrPublicationTarget[];
}): PrPublicationObservation {
	void input.toolName; // detection is command-based, like the PRLINK-0 gate
	const operations = detectPublicationOperations(input.commands);
	if (operations.length === 0) {
		return {
			status: "none",
			target: null,
			explicitUnlinked: false,
			operation: null,
			kind: null,
			identities: [],
			reason: null,
		};
	}
	const target = resolvePublicationTarget(operations, input.linkedPullRequests);
	const primary = operations[0];
	if (target === null) {
		// An explicit selector that matches no linked PR demonstrably targets
		// another PR: no capture, no pause. An ambiguous selector (unquoted
		// numbers inside bodies, no selector with several linked PRs, ...)
		// is uncertain for every linked PR and must pause automation.
		const unlinked = isExplicitUnlinked(operations, input.linkedPullRequests);
		return {
			status: unlinked ? "none" : "uncertain",
			target: null,
			explicitUnlinked: unlinked,
			operation: primary.operation,
			kind: primary.kind,
			identities: [],
			reason: unlinked ? null : "Could not resolve which linked pull request the publication targets.",
		};
	}
	// A write whose endpoint cannot be attributed to a comment, review, or
	// inline reply can never yield identities from its output: an explicit
	// uncertainty even before execution finishes.
	if (operations.some((operation) => operation.kind === null)) {
		return {
			status: "uncertain",
			target,
			explicitUnlinked: false,
			operation: primary.operation,
			kind: primary.kind,
			identities: [],
			reason:
				"The gh api write targeted an endpoint that cannot be attributed to a PR comment, review, or inline reply.",
		};
	}
	if (input.output === null) {
		return {
			status: "pending",
			target,
			explicitUnlinked: false,
			operation: primary.operation,
			kind: primary.kind,
			identities: [],
			reason: null,
		};
	}
	const resolved = resolvePublicationOutput({
		operations,
		target,
		output: input.output,
		error: input.error,
	});
	return {
		status: resolved.status,
		target,
		explicitUnlinked: false,
		operation: primary.operation,
		kind: primary.kind,
		identities: resolved.identities,
		reason: resolved.reason,
	};
}
