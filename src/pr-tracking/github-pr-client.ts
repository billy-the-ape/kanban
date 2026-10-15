// COMMENT-0 / foundation: fixed noninteractive GitHub provider adapter.
//
// Reads go through direct `gh api --hostname github.com` (never an
// interactive shell), with the service's existing gh auth/environment, cwd at
// the owning repository, a 30-second timeout, and the existing 8 MiB output
// bound per page. Published review bodies, inline review feedback, and
// conversation comments are fetched with complete pagination; a snapshot is
// only complete when every page succeeds (a partial API failure cannot
// dispatch). Bot policy (foundation): nonempty submitted review bodies and
// inline feedback from human and bot accounts are eligible; empty/
// approval-only review events, unpublished reviews, resolved threads, and
// bot conversation/status chatter are ignored.
import { createHash } from "node:crypto";
import { runGhCommand } from "../workspace/git-delivery";
import type { PrFeedbackEvent } from "./feedback-fingerprint";

/** Injectable gh runner (tests pass fakes); defaults to the gh CLI. */
export type GitHubPrCommandRunner = (
	args: string[],
	cwd: string,
) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; missingBinary: boolean }>;

export interface GitHubPrIdentity {
	/** Must be "github.com" in v1. */
	host: string;
	/** "owner/repo". */
	repository: string;
	number: number;
}

export interface GitHubPrSnapshot {
	/** True only when every page of every source succeeded. */
	complete: boolean;
	/** Visible auth-blocker reason when gh/credentials are unavailable. */
	authError: string | null;
	prState: "open" | "closed" | "merged" | null;
	headSha: string | null;
	headRef?: string | null;
	headRepository?: string | null;
	htmlUrl: string | null;
	/** Eligible feedback events (not persisted in workflow records; may enter task chat). */
	events: PrFeedbackEvent[];
}

export interface GitHubPrClient {
	fetchSnapshot(pr: GitHubPrIdentity, cwd: string, accessScopeId: string): Promise<GitHubPrSnapshot>;
}

const PER_PAGE = 100;
/** Hard page cap per source; a longer source is treated as incomplete. */
const MAX_PAGES = 20;
const REST_PATH_TIMEOUT_MS = 30_000;

function defaultRunner(args: string[], cwd: string) {
	return runGhCommand(args, cwd, REST_PATH_TIMEOUT_MS);
}

/**
 * Resolves the opaque, nonsecret identifier of the active github.com
 * credential context (the authenticated account login). A missing gh or
 * missing credential rejects with a visible, actionable error — the caller
 * surfaces it as a blocker rather than hot-looping or auto-launching a login.
 */
export async function resolveGitHubAccessScopeId(runner: GitHubPrCommandRunner = defaultRunner): Promise<string> {
	const result = await runner(["api", "--hostname", "github.com", "user", "--jq", ".login"], process.cwd());
	const login = result.stdout.trim();
	if (!result.ok || !login) {
		throw new Error(
			result.missingBinary
				? "gh CLI is not installed. Install gh or run it from a PATH that includes it."
				: `GitHub authentication unavailable: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
		);
	}
	return login;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function toEpochMs(raw: unknown): number {
	if (typeof raw !== "string") {
		return 0;
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : 0;
}

interface FeedbackMetadata {
	html_url?: unknown;
	user?: { login?: unknown; type?: unknown } | null;
}
function feedbackMetadata(entry: FeedbackMetadata) {
	return {
		url: typeof entry.html_url === "string" ? entry.html_url : undefined,
		author: typeof entry.user?.login === "string" ? entry.user.login : undefined,
	};
}

interface ReviewEntry extends FeedbackMetadata {
	id: unknown;
	state: unknown;
	body: unknown;
	// GET /pulls/{n}/reviews has no updated_at; submitted_at is the timestamp.
	submitted_at: unknown;
	updated_at: unknown;
}

interface InlineCommentEntry extends FeedbackMetadata {
	path?: unknown;
	line?: unknown;
	original_line?: unknown;
	diff_hunk?: unknown;
	id: unknown;
	body: unknown;
	updated_at: unknown;
	pull_request_review_id: unknown;
}

interface ConversationCommentEntry extends FeedbackMetadata {
	id: unknown;
	body: unknown;
	updated_at: unknown;
	user: { type?: unknown; login?: unknown } | null | undefined;
}

interface PullMetadataEntry {
	state: unknown;
	head: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null } | null | undefined;
	merged?: unknown;
	html_url: unknown;
}

/**
 * Fetches every page of a REST list endpoint. Returns `complete: false` when
 * any page fails or the page cap is exceeded.
 */
async function fetchAllPages<T>(
	runner: GitHubPrCommandRunner,
	basePath: string,
	cwd: string,
): Promise<{ items: T[]; complete: boolean }> {
	const items: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const result = await runner(
			["api", "--hostname", "github.com", `${basePath}?per_page=${PER_PAGE}&page=${page}`],
			cwd,
		);
		if (!result.ok) {
			return { items, complete: false };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			return { items, complete: false };
		}
		if (!Array.isArray(parsed)) {
			return { items, complete: false };
		}
		items.push(...(parsed as T[]));
		if (parsed.length < PER_PAGE) {
			return { items, complete: true };
		}
	}
	return { items, complete: false };
}

/**
 * Resolves the database ids of inline comments in resolved review threads via
 * GraphQL (REST alone does not expose thread resolution state).
 */
async function fetchResolvedInlineCommentIds(
	runner: GitHubPrCommandRunner,
	pr: GitHubPrIdentity,
	cwd: string,
): Promise<{ ids: Set<number>; complete: boolean }> {
	const [owner, ...nameParts] = pr.repository.split("/");
	if (!owner || nameParts.length === 0) {
		return { ids: new Set(), complete: false };
	}
	const name = nameParts.join("/");
	const query = [
		"query GetResolvedInlineComments($owner: String!, $name: String!, $number: Int!, $cursor: String) {",
		"  repository(owner: $owner, name: $name) {",
		"    pullRequest(number: $number) {",
		"      reviewThreads(first: 100, after: $cursor) {",
		"        pageInfo { hasNextPage endCursor }",
		"        nodes {",
		"          isResolved",
		"          comments(first: 100) { pageInfo { hasNextPage } nodes { databaseId } }",
		"        }",
		"      }",
		"    }",
		"  }",
		"}",
	].join("\n");
	const ids = new Set<number>();
	let complete = true;
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const args: string[] = [
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"-f",
			`query=${query}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
			"-F",
			`number=${pr.number}`,
		];
		if (cursor) {
			args.push("-f", `cursor=${cursor}`);
		}
		const result = await runner(args, cwd);
		if (!result.ok) {
			complete = false;
			break;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			complete = false;
			break;
		}
		const data = parsed as {
			data?: {
				repository?: {
					pullRequest?: {
						reviewThreads?: {
							pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
							nodes?: Array<{
								isResolved?: boolean;
								comments?: {
									pageInfo?: { hasNextPage?: boolean };
									nodes?: Array<{ databaseId?: number }>;
								} | null;
							} | null>;
						} | null;
					} | null;
				} | null;
			} | null;
		};
		const reviewThreads = data?.data?.repository?.pullRequest?.reviewThreads;
		if (!reviewThreads?.pageInfo) return { ids, complete: false };
		const threads = reviewThreads.nodes ?? [];
		for (const thread of threads) {
			if (!thread?.isResolved) {
				continue;
			}
			// A resolved thread longer than one page would leave its later
			// comments looking unresolved: never report that as complete.
			if (thread.comments?.pageInfo?.hasNextPage) {
				complete = false;
			}
			for (const comment of thread.comments?.nodes ?? []) {
				if (typeof comment?.databaseId === "number") {
					ids.add(comment.databaseId);
				}
			}
		}
		const pageInfo = data?.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
		if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
			return { ids, complete };
		}
		cursor = pageInfo.endCursor;
	}
	// Loop exited on a failure, or the page cap was hit with more threads.
	return { ids, complete: false };
}

function mapReviews(entries: ReviewEntry[]): PrFeedbackEvent[] {
	const events: PrFeedbackEvent[] = [];
	// A later approval supersedes that reviewer's earlier change-request body,
	// never another reviewer's requests or unresolved inline threads.
	const decisions = new Map<string, ReviewEntry>();
	for (const entry of entries) {
		const author = entry.user?.login;
		if (typeof author !== "string" || (entry.state !== "APPROVED" && entry.state !== "CHANGES_REQUESTED")) continue;
		const previous = decisions.get(author);
		if (!previous || toEpochMs(entry.submitted_at) >= toEpochMs(previous.submitted_at)) decisions.set(author, entry);
	}
	for (const entry of entries) {
		const decision = typeof entry.user?.login === "string" ? decisions.get(entry.user.login) : undefined;
		if (entry.state === "APPROVED" || (entry.state === "CHANGES_REQUESTED" && decision?.state === "APPROVED"))
			continue;
		// PENDING (unpublished) and DISMISSED reviews are never eligible;
		// empty bodies (including approval-only events) are ignored.
		if (typeof entry.state !== "string" || entry.state === "PENDING" || entry.state === "DISMISSED") {
			continue;
		}
		const body = typeof entry.body === "string" ? entry.body.trim() : "";
		if (!body || typeof entry.id !== "number") {
			continue;
		}
		// Real review objects carry submitted_at; updated_at only exists
		// on some responses after editing; prefer it when present.
		const updatedAt = toEpochMs(entry.updated_at) || toEpochMs(entry.submitted_at);
		if (updatedAt === 0) {
			continue;
		}
		events.push({
			kind: "review",
			...feedbackMetadata(entry),
			providerId: `review-${entry.id}`,
			updatedAt,
			bodyDigest: sha256Hex(body),
			body,
		});
	}
	return events;
}

/** Ids of unsubmitted (PENDING) reviews: their draft inline comments are not feedback yet. */
function pendingReviewIds(entries: ReviewEntry[]): Set<number> {
	const ids = new Set<number>();
	for (const entry of entries) {
		if (entry.state === "PENDING" && typeof entry.id === "number") {
			ids.add(entry.id);
		}
	}
	return ids;
}

function mapInlineComments(
	entries: InlineCommentEntry[],
	resolvedIds: Set<number>,
	draftReviewIds: Set<number>,
): PrFeedbackEvent[] {
	const events: PrFeedbackEvent[] = [];
	for (const entry of entries) {
		if (typeof entry.id !== "number" || resolvedIds.has(entry.id)) {
			continue;
		}
		// The authenticated user's own draft comments are returned by this
		// endpoint too; they are unpublished until the review is submitted.
		if (typeof entry.pull_request_review_id === "number" && draftReviewIds.has(entry.pull_request_review_id)) {
			continue;
		}
		const body = typeof entry.body === "string" ? entry.body.trim() : "";
		if (!body) {
			continue;
		}
		const updatedAt = toEpochMs(entry.updated_at);
		if (updatedAt === 0) {
			continue;
		}
		events.push({
			kind: "inline",
			...feedbackMetadata(entry),
			path: typeof entry.path === "string" ? entry.path : undefined,
			line:
				typeof entry.line === "number"
					? entry.line
					: typeof entry.original_line === "number"
						? entry.original_line
						: undefined,
			diffHunk: typeof entry.diff_hunk === "string" ? entry.diff_hunk : undefined,
			providerId: `inline-${entry.id}`,
			updatedAt,
			bodyDigest: sha256Hex(body),
			body,
			pullRequestReviewId: typeof entry.pull_request_review_id === "number" ? entry.pull_request_review_id : null,
		});
	}
	return events;
}

function mapConversationComments(entries: ConversationCommentEntry[]): PrFeedbackEvent[] {
	const events: PrFeedbackEvent[] = [];
	for (const entry of entries) {
		// Human conversation comments only; bot conversation/status chatter is
		// ignored. A human comment is never excluded because it uses the
		// service's own authenticated account.
		if (entry.user?.type !== "User" || typeof entry.id !== "number") {
			continue;
		}
		const body = typeof entry.body === "string" ? entry.body.trim() : "";
		if (!body) {
			continue;
		}
		const updatedAt = toEpochMs(entry.updated_at);
		if (updatedAt === 0) {
			continue;
		}
		events.push({
			kind: "conversation",
			...feedbackMetadata(entry),
			providerId: `conversation-${entry.id}`,
			updatedAt,
			bodyDigest: sha256Hex(body),
			body,
		});
	}
	return events;
}

export function createGitHubPrClient(
	options: { runner?: GitHubPrCommandRunner; accessScopeResolver?: () => Promise<string> } = {},
): GitHubPrClient {
	const runner = options.runner ?? defaultRunner;
	let cachedScope: Promise<string> | null = null;
	const accessScopeResolver =
		options.accessScopeResolver ??
		(() => {
			if (!cachedScope) {
				cachedScope = resolveGitHubAccessScopeId(runner).catch((error: unknown) => {
					// Invalidate the cache on failure so a later fix (e.g. a
					// completed `gh auth login`) is picked up on the next poll.
					cachedScope = null;
					throw error;
				});
			}
			return cachedScope;
		});

	return {
		async fetchSnapshot(pr: GitHubPrIdentity, cwd: string, accessScopeId: string): Promise<GitHubPrSnapshot> {
			if (pr.host !== "github.com") {
				return {
					complete: false,
					authError: "Automation unsupported: only github.com links are supported in v1.",
					prState: null,
					headSha: null,
					htmlUrl: null,
					events: [],
				};
			}
			try {
				// Resolve the credential context before reading; a missing gh or
				// credential is a visible auth blocker, never a hot login loop.
				await accessScopeResolver();
			} catch (error) {
				return {
					complete: false,
					authError: error instanceof Error ? error.message : String(error),
					prState: null,
					headSha: null,
					htmlUrl: null,
					events: [],
				};
			}
			void accessScopeId;
			const metadataResult = await runner(
				["api", "--hostname", "github.com", `repos/${pr.repository}/pulls/${pr.number}`],
				cwd,
			);
			if (!metadataResult.ok) {
				return {
					complete: false,
					authError: null,
					prState: null,
					headSha: null,
					htmlUrl: null,
					events: [],
				};
			}
			let metadata: PullMetadataEntry;
			try {
				metadata = JSON.parse(metadataResult.stdout) as PullMetadataEntry;
			} catch {
				return { complete: false, authError: null, prState: null, headSha: null, htmlUrl: null, events: [] };
			}
			const normalizedState = typeof metadata.state === "string" ? metadata.state.toUpperCase() : "";
			const prState =
				metadata.merged === true
					? "merged"
					: normalizedState === "OPEN"
						? "open"
						: normalizedState === "MERGED"
							? "merged"
							: normalizedState === "CLOSED"
								? "closed"
								: null;

			// Sources are read in parallel, but each source paginates one page
			// at a time, so at most four reads are in flight at once — within
			// the runtime-wide four-read bound.
			const [reviews, inlineComments, conversationComments, resolved] = await Promise.all([
				fetchAllPages<ReviewEntry>(runner, `repos/${pr.repository}/pulls/${pr.number}/reviews`, cwd),
				fetchAllPages<InlineCommentEntry>(runner, `repos/${pr.repository}/pulls/${pr.number}/comments`, cwd),
				fetchAllPages<ConversationCommentEntry>(runner, `repos/${pr.repository}/issues/${pr.number}/comments`, cwd),
				fetchResolvedInlineCommentIds(runner, pr, cwd),
			]);

			return {
				complete: reviews.complete && inlineComments.complete && conversationComments.complete && resolved.complete,
				authError: null,
				prState,
				headSha: typeof metadata.head?.sha === "string" ? metadata.head.sha : null,
				headRef: typeof metadata.head?.ref === "string" ? metadata.head.ref : null,
				headRepository: typeof metadata.head?.repo?.full_name === "string" ? metadata.head.repo.full_name : null,
				htmlUrl: typeof metadata.html_url === "string" ? metadata.html_url : null,
				events: [
					...mapReviews(reviews.items),
					...mapInlineComments(inlineComments.items, resolved.ids, pendingReviewIds(reviews.items)),
					...mapConversationComments(conversationComments.items),
				],
			};
		},
	};
}
