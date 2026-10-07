// PRTRACK-0: fixed noninteractive GitHub gh adapter.
//
// Reads go through `gh api --hostname github.com` via direct execFile with a
// sanitized, prompt-disabled environment (never an interactive shell), a
// 30-second timeout, and an 8 MiB output bound per page. At most four read
// requests may be in flight runtime-wide.
//
// Known deviation from the plan's "per-source ETag/conditional reads": the gh
// CLI does not expose response headers (no `If-None-Match` / `Retry-After`),
// so "conditional reads" compare the SHA-256 of the previous full response
// body: an unchanged body is reported as `not_modified` and the caller keeps
// its last state. Every poll still performs a full GET (no rate-limit credit
// for 304s). The coordinator compensates: `not_modified` sources contribute
// their retained events, and any failed store write forces a `fresh` re-read
// so applied state never lags the recorded body digest. Rate-limit deadlines
// come from the `/rate_limit` endpoint (primary core window); the 900 s
// backoff cap covers secondary limits that endpoint does not report.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubPrMetadataSnapshot, GitHubPrNormalizedFeedbackEvent } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import type { ParsedCanonicalPrKey } from "./pr-identity";
import { normalizePrMetadata, type PrThreadInfo, sha256Digest } from "./pr-snapshots";

const execFileAsync = promisify(execFile);

export const GITHUB_TRACKING_HOST = "github.com";
export const GH_API_TIMEOUT_MS = 30_000;
export const GH_API_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Maximum read requests in flight runtime-wide. */
export const PR_MAX_IN_FLIGHT_READS = 4;
const REST_LIST_PAGE_SIZE = 100;
const ERROR_DETAIL_MAX_CHARS = 500;

/**
 * Noninteractive gh environment: sanitized Git routing plus prompt disabling.
 * Prevents any interactive login flow; missing credentials must surface as a
 * visible auth blocker, never a login loop.
 */
export function createNonInteractiveGhEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return createGitProcessEnv({
		GH_PROMPT_DISABLED: "1",
		GH_NO_PROMPT: "1",
		NO_COLOR: "1",
		...overrides,
	});
}

export type GhAdapterFailureCategory =
	| "auth"
	| "rate_limit"
	| "not_found"
	| "access"
	| "network"
	| "timeout"
	| "buffer_bound"
	| "partial_page";

export interface GhAdapterFailure {
	category: GhAdapterFailureCategory;
	/** Sanitized, bounded error detail with a timestamp. */
	message: string;
	at: number;
	/** Epoch ms when the API rate limit resets (rate_limit only). */
	rateLimitResetAt?: number;
}

export interface AccessScope {
	/** Opaque hash of host + login + credential source; never token material. */
	accessScopeId: string;
	login: string;
	tokenSource: string;
}

export type AccessScopeResult = { ok: true; scope: AccessScope } | { ok: false; failure: GhAdapterFailure };

export type MetadataReadResult =
	| { kind: "ok"; metadata: GitHubPrMetadataSnapshot; nodeId: string; bodyDigest: string }
	| { kind: "not_modified" }
	| { kind: "failed"; failure: GhAdapterFailure };

export type FeedbackReadResult =
	| { kind: "ok"; events: GitHubPrNormalizedFeedbackEvent[]; bodyDigest: string }
	| { kind: "ok_threads"; threads: Map<string, PrThreadInfo> }
	| { kind: "not_modified" }
	| { kind: "failed"; failure: GhAdapterFailure };

export interface GhRunnerCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	missingBinary: boolean;
	timeout?: boolean;
	bufferBound?: boolean;
}

/** Injectable gh runner (tests substitute a scripted runner). */
export type GhApiRunner = (args: string[], cwd: string) => Promise<GhRunnerCommandResult>;

export interface GitHubGhAdapterOptions {
	ghRunner?: GhApiRunner;
	now?: () => number;
	timeoutMs?: number;
	maxBufferBytes?: number;
	inFlightLimit?: number;
	/** Deterministic cwd for gh calls (does not affect request or credentials). */
	cwd?: string;
}

function sanitizeErrorDetail(stderr: string): string {
	const redacted = stderr.replace(/gh_[A-Za-z0-9]{20,}/g, "[redacted]").replace(/token=[^\s"]+/gi, "token=[redacted]");
	return redacted.slice(0, ERROR_DETAIL_MAX_CHARS);
}

function createDefaultGhRunner(timeoutMs: number, maxBufferBytes: number): GhApiRunner {
	return async (args, cwd) => {
		try {
			const { stdout, stderr } = await execFileAsync("gh", args, {
				cwd,
				encoding: "utf8",
				maxBuffer: maxBufferBytes,
				env: createNonInteractiveGhEnv(),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return {
				ok: true,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? ""),
				exitCode: 0,
				missingBinary: false,
			};
		} catch (error) {
			const candidate = error as {
				code?: string | number | null;
				name?: string;
				signal?: string;
				stdout?: unknown;
				stderr?: unknown;
				message?: unknown;
			};
			const message = String(candidate.message ?? "");
			if (candidate.code === "ENOENT" || /ENOENT/.test(message)) {
				return { ok: false, stdout: "", stderr: message, exitCode: -1, missingBinary: true };
			}
			if (candidate.name === "TimeoutError" || candidate.name === "AbortError") {
				return {
					ok: false,
					stdout: "",
					stderr: "request timed out",
					exitCode: -1,
					missingBinary: false,
					timeout: true,
				};
			}
			// Node 12+ reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER ("stdout maxBuffer
			// length exceeded"); match the code, not just legacy message text.
			if (
				candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
				/ERR_CHILD_PROCESS_STDIO_MAXBUFFER|maxBuffer (size|length) exceeded/.test(message)
			) {
				return {
					ok: false,
					stdout: "",
					stderr: message,
					exitCode: -1,
					missingBinary: false,
					bufferBound: true,
				};
			}
			return {
				ok: false,
				stdout: String(candidate.stdout ?? ""),
				stderr: String(candidate.stderr ?? message),
				exitCode: typeof candidate.code === "number" ? candidate.code : -1,
				missingBinary: false,
			};
		}
	};
}

type RestCallOutcome =
	| { kind: "json"; data: unknown; stdout: string }
	| { kind: "not_modified" }
	| { kind: "failure"; failure: GhAdapterFailure };

export class GitHubGhAdapter {
	private readonly runner: GhApiRunner;
	private readonly now: () => number;
	private readonly cwd: string;
	private readonly inFlightLimit: number;
	private inFlight = 0;
	private waiters: Array<() => void> = [];
	private cachedRateLimitResetAt: number | null = null;

	constructor(options: GitHubGhAdapterOptions = {}) {
		this.runner =
			options.ghRunner ??
			createDefaultGhRunner(
				options.timeoutMs ?? GH_API_TIMEOUT_MS,
				options.maxBufferBytes ?? GH_API_MAX_BUFFER_BYTES,
			);
		this.now = options.now ?? Date.now;
		this.cwd = options.cwd ?? process.cwd();
		this.inFlightLimit = options.inFlightLimit ?? PR_MAX_IN_FLIGHT_READS;
	}

	private async acquireSlot(): Promise<void> {
		if (this.inFlight < this.inFlightLimit) {
			this.inFlight += 1;
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
		this.inFlight += 1;
	}

	private releaseSlot(): void {
		this.inFlight -= 1;
		const next = this.waiters.shift();
		if (next) {
			next();
		}
	}

	private classifyExit(result: GhRunnerCommandResult): RestCallOutcome {
		const at = this.now();
		const detail = sanitizeErrorDetail(result.stderr);
		if (result.missingBinary) {
			return {
				kind: "failure",
				failure: { category: "auth", message: "gh CLI is not installed (ENOENT)", at },
			};
		}
		if (result.timeout) {
			return { kind: "failure", failure: { category: "timeout", message: detail || "request timed out", at } };
		}
		if (result.bufferBound) {
			return {
				kind: "failure",
				failure: { category: "buffer_bound", message: detail || "output bound exceeded", at },
			};
		}
		if (result.ok) {
			try {
				return { kind: "json", data: JSON.parse(result.stdout), stdout: result.stdout };
			} catch {
				return { kind: "failure", failure: { category: "network", message: "unparseable gh response", at } };
			}
		}
		if (/HTTP 304|Not Modified/i.test(result.stderr)) {
			return { kind: "not_modified" };
		}
		if (/HTTP 404|Not Found/i.test(result.stderr)) {
			return { kind: "failure", failure: { category: "not_found", message: detail, at } };
		}
		if (
			/HTTP 401|Authentication failed|not logged in|Invalid OAuth token|bad credentials|GH_TOKEN/i.test(
				result.stderr,
			)
		) {
			return { kind: "failure", failure: { category: "auth", message: detail, at } };
		}
		if (/HTTP 429|rate limit|abuse/i.test(result.stderr)) {
			return {
				kind: "failure",
				failure: {
					category: "rate_limit",
					message: detail,
					at,
					rateLimitResetAt: this.cachedRateLimitResetAt ?? undefined,
				},
			};
		}
		// A 403 (SAML enforcement, missing repo access, ...) or a 451
		// (content unavailable by rule) is a permission problem, not a
		// transient network failure: surface it as a visible access blocker
		// instead of retrying on the ordinary backoff ladder forever.
		if (/HTTP 403|HTTP 451/i.test(result.stderr)) {
			return { kind: "failure", failure: { category: "access", message: detail, at } };
		}
		return {
			kind: "failure",
			failure: { category: "network", message: detail || `gh exited ${result.exitCode}`, at },
		};
	}

	/**
	 * Best-effort rate-limit reset deadline; never throws. Runs WITHOUT
	 * holding a read slot: the in-flight reads are exactly the ones that get
	 * throttled, so taking a slot here would deadlock the cap when every
	 * slot is busy with rate-limit failures. The `rate_limit` endpoint is
	 * not itself rate limited, so a direct runner call is safe.
	 */
	private async fetchRateLimitReset(): Promise<number | null> {
		const result = await this.runner(["api", "--hostname", GITHUB_TRACKING_HOST, "rate_limit"], this.cwd);
		const outcome = this.classifyExit(result);
		if (outcome.kind !== "json") {
			return null;
		}
		const data = outcome.data as { resources?: { core?: { reset?: number } } };
		const reset = data.resources?.core?.reset;
		if (typeof reset !== "number" || !Number.isFinite(reset)) {
			return null;
		}
		this.cachedRateLimitResetAt = reset * 1000;
		return this.cachedRateLimitResetAt;
	}

	/** Public best-effort rate-limit reset deadline; never throws. */
	async refreshRateLimitReset(): Promise<number | null> {
		return await this.fetchRateLimitReset();
	}

	/** One REST call through gh (single page or single object). */
	async callRest(endpoint: string): Promise<RestCallOutcome> {
		await this.acquireSlot();
		try {
			const result = await this.runner(["api", "--hostname", GITHUB_TRACKING_HOST, endpoint], this.cwd);
			const outcome = this.classifyExit(result);
			if (outcome.kind === "failure" && outcome.failure.category === "rate_limit") {
				// Refresh on EVERY rate-limit failure (never cached forever):
				// the next throttled window an hour later carries a new reset.
				const resetAt = await this.fetchRateLimitReset();
				if (resetAt !== null) {
					outcome.failure.rateLimitResetAt = resetAt;
				}
			}
			return outcome;
		} finally {
			this.releaseSlot();
		}
	}

	/** One GraphQL call through gh. */
	private async callGraphql(query: string, variables: Record<string, string>): Promise<RestCallOutcome> {
		await this.acquireSlot();
		try {
			const args = ["api", "--hostname", GITHUB_TRACKING_HOST, "graphql", "-f", `query=${query}`];
			for (const [key, value] of Object.entries(variables)) {
				args.push("-f", `${key}=${value}`);
			}
			const result = await this.runner(args, this.cwd);
			const outcome = this.classifyExit(result);
			if (outcome.kind === "json") {
				const data = outcome.data as { errors?: Array<{ message?: string }> };
				const message = (data.errors ?? []).map((item) => String(item.message ?? "")).join("; ");
				if (data.errors && data.errors.length > 0) {
					if (/rate limit|secondary/i.test(message)) {
						const resetAt = await this.fetchRateLimitReset();
						return {
							kind: "failure",
							failure: {
								category: "rate_limit",
								message: sanitizeErrorDetail(message),
								at: this.now(),
								...(resetAt !== null ? { rateLimitResetAt: resetAt } : {}),
							},
						};
					}
					if (/not found/i.test(message)) {
						return {
							kind: "failure",
							failure: { category: "not_found", message: sanitizeErrorDetail(message), at: this.now() },
						};
					}
					return {
						kind: "failure",
						failure: { category: "network", message: sanitizeErrorDetail(message), at: this.now() },
					};
				}
			}
			return outcome;
		} finally {
			this.releaseSlot();
		}
	}

	/**
	 * Resolve the authenticated github.com access scope (noninteractive).
	 * Identity comes from the same adapter path as every other read —
	 * `gh api user` (stable JSON, always the ACTIVE credential) — instead of
	 * scraping `gh auth status` text, which changed format with the
	 * multi-account rewrite and lists every account (first-match could pick
	 * an inactive one). 401, missing binary, or missing login are the auth
	 * blocker.
	 */
	/** Resolve the authenticated github.com access scope (noninteractive). */
	async resolveAccessScope(): Promise<AccessScopeResult> {
		const at = this.now();
		await this.acquireSlot();
		try {
			const result = await this.runner(["auth", "status", "--hostname", GITHUB_TRACKING_HOST], this.cwd);
			if (result.missingBinary) {
				return {
					ok: false,
					failure: { category: "auth", message: "gh CLI is not installed (ENOENT)", at },
				};
			}
			if (!result.ok) {
				return {
					ok: false,
					failure: {
						category: "auth",
						message: sanitizeErrorDetail(result.stderr || "gh auth status failed"),
						at,
					},
				};
			}
			const match = result.stdout.match(/Logged in to ([\w.-]+) as (\w+) \(([^)]+)\)/);
			if (!match) {
				return {
					ok: false,
					failure: {
						category: "auth",
						message: sanitizeErrorDetail(result.stdout || "no authenticated GitHub account found"),
						at,
					},
				};
			}
			const [, host, login, tokenSource] = match;
			const scopeHost = host ?? GITHUB_TRACKING_HOST;
			return {
				ok: true,
				scope: {
					accessScopeId: sha256Digest(`${scopeHost}|${login}|${tokenSource}`),
					login: login ?? "unknown",
					tokenSource: tokenSource ?? "unknown",
				},
			};
		} finally {
			this.releaseSlot();
		}
	}

	private bodyDigestCache = new Map<string, string>();

	private conditionalKey(parsed: ParsedCanonicalPrKey, scope: AccessScope, source: string): string {
		return `${parsed.host}|${parsed.repository}|${parsed.number}|${scope.accessScopeId}|${source}`;
	}

	private applyConditionalRead(key: string, body: string, fresh: boolean): "changed" | "not_modified" {
		const digest = sha256Digest(body);
		if (!fresh && this.bodyDigestCache.get(key) === digest) {
			return "not_modified";
		}
		this.bodyDigestCache.set(key, digest);
		return "changed";
	}

	/**
	 * Read PR metadata (single REST object) with conditional-read retention:
	 * an unchanged body reports `not_modified` so callers keep last state.
	 */
	async readPrMetadata(
		parsed: ParsedCanonicalPrKey,
		scope: AccessScope,
		options?: { fresh?: boolean },
	): Promise<MetadataReadResult> {
		const endpoint = `repos/${parsed.repository}/pulls/${parsed.number}`;
		const outcome = await this.callRest(endpoint);
		if (outcome.kind === "not_modified") {
			return { kind: "not_modified" };
		}
		if (outcome.kind === "failure") {
			return { kind: "failed", failure: outcome.failure };
		}
		const condition = this.applyConditionalRead(
			this.conditionalKey(parsed, scope, "metadata"),
			outcome.stdout,
			options?.fresh ?? false,
		);
		if (condition === "not_modified") {
			return { kind: "not_modified" };
		}
		const pr = outcome.data as { node_id?: unknown };
		const nodeId = typeof pr.node_id === "string" && pr.node_id.length > 0 ? pr.node_id : "";
		return {
			kind: "ok",
			metadata: normalizePrMetadata(outcome.data, scope.accessScopeId, this.now()),
			nodeId,
			bodyDigest: sha256Digest(outcome.stdout),
		};
	}

	/**
	 * Read one paginated REST list source completely. A mid-list failure is a
	 * partial-page failure: the caller retains last state and pauses decisions.
	 */
	async readRestListSource(
		parsed: ParsedCanonicalPrKey,
		scope: AccessScope,
		source: "reviews" | "conversationComments" | "inlineComments",
		endpointBase: string,
		normalize: (items: unknown[], ownAccountLogin: string) => GitHubPrNormalizedFeedbackEvent[],
		options?: { fresh?: boolean },
	): Promise<FeedbackReadResult> {
		const all: unknown[] = [];
		for (let page = 1; ; page += 1) {
			const outcome = await this.callRest(`${endpointBase}?per_page=${REST_LIST_PAGE_SIZE}&page=${page}`);
			if (outcome.kind === "not_modified") {
				// Page 1 unchanged: the combined body cannot have changed either.
				if (page === 1) {
					return { kind: "not_modified" };
				}
				// A later 304 means we cannot reconstruct the full list body.
				return {
					kind: "failed",
					failure: {
						category: "partial_page",
						message: `conditional 304 on page ${page}; retaining last state`,
						at: this.now(),
					},
				};
			}
			if (outcome.kind === "failure") {
				return {
					kind: "failed",
					failure: page === 1 ? outcome.failure : { ...outcome.failure, category: "partial_page" },
				};
			}
			const items = Array.isArray(outcome.data) ? outcome.data : [];
			all.push(...items);
			// Complete pagination: stop only on a short (final) page.
			if (items.length < REST_LIST_PAGE_SIZE) {
				break;
			}
			if (page >= 1000) {
				break; // safety guard against runaway pagination
			}
		}
		const body = JSON.stringify(all);
		const condition = this.applyConditionalRead(
			this.conditionalKey(parsed, scope, source),
			body,
			options?.fresh ?? false,
		);
		if (condition === "not_modified") {
			return { kind: "not_modified" };
		}
		return { kind: "ok", events: normalize(all, scope.login), bodyDigest: sha256Digest(body) };
	}

	/**
	 * Read review-thread resolution/outdated state via paginated GraphQL.
	 * The returned map is keyed by BOTH the GraphQL node id and the numeric
	 * `databaseId` (REST `id` as string) for every comment in the thread, and
	 * `outdated` is carried separately from `resolved`. Comment pages within
	 * a thread are paginated too, so very long threads are not truncated.
	 */
	async readReviewThreads(
		parsed: ParsedCanonicalPrKey,
		scope: AccessScope,
		nodeId: string,
		options?: { fresh?: boolean },
	): Promise<FeedbackReadResult> {
		const key = this.conditionalKey(parsed, scope, "threads");
		const threads = new Map<string, PrThreadInfo>();
		let after: string | null = null;
		for (let guard = 0; guard < 100; guard += 1) {
			const variables: Record<string, string> = { nodeId };
			if (after !== null) {
				variables.after = after;
			}
			const outcome = await this.callGraphql(THREADS_QUERY, variables);
			if (outcome.kind === "not_modified") {
				return { kind: "not_modified" };
			}
			if (outcome.kind === "failure") {
				return { kind: "failed", failure: outcome.failure };
			}
			const data = outcome.data as {
				node?: {
					reviewThreads?: {
						pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
						nodes?: Array<{
							id?: string | null;
							isResolved?: boolean;
							isOutdated?: boolean;
							deleted?: boolean;
							comments?: {
								pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
								nodes?: Array<{ id?: string | null; databaseId?: number | null }>;
							};
						}>;
					};
				};
			};
			const page = data.node?.reviewThreads;
			for (const threadNode of page?.nodes ?? []) {
				if (typeof threadNode.id !== "string" || threadNode.id.length === 0) {
					continue;
				}
				const info: PrThreadInfo = {
					resolved: threadNode.isResolved === true,
					outdated: threadNode.isOutdated === true,
					deleted: threadNode.deleted === true,
				};
				// Deleted threads expose no comments; keep the thread node id
				// keyed so retained events can still be flagged.
				if (info.deleted) {
					threads.set(threadNode.id, info);
				}
				const commentNodes: Array<{ id?: string | null; databaseId?: number | null }> = [
					...(threadNode.comments?.nodes ?? []),
				];
				// Paginate comments within the thread (very long threads).
				let commentsAfter = threadNode.comments?.pageInfo?.endCursor;
				let commentsHasNext = threadNode.comments?.pageInfo?.hasNextPage === true;
				while (commentsHasNext && typeof commentsAfter === "string" && commentsAfter.length > 0) {
					const commentOutcome = await this.callGraphql(THREAD_COMMENTS_QUERY, {
						threadId: threadNode.id,
						after: commentsAfter,
					});
					if (commentOutcome.kind === "not_modified") {
						return { kind: "not_modified" };
					}
					if (commentOutcome.kind === "failure") {
						return { kind: "failed", failure: commentOutcome.failure };
					}
					const commentData = commentOutcome.data as {
						node?: {
							comments?: {
								pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
								nodes?: Array<{ id?: string | null; databaseId?: number | null }>;
							};
						};
					};
					const extra = commentData.node?.comments;
					if (!extra) {
						break;
					}
					commentNodes.push(...(extra.nodes ?? []));
					commentsHasNext = extra.pageInfo?.hasNextPage === true;
					const nextAfter = extra.pageInfo?.endCursor;
					if (typeof nextAfter !== "string" || nextAfter === commentsAfter) {
						break;
					}
					commentsAfter = nextAfter;
					if (commentNodes.length > 100 * 100) {
						break; // safety guard against runaway pagination
					}
				}
				for (const comment of commentNodes) {
					if (typeof comment.id !== "string" || comment.id.length === 0) {
						continue;
					}
					threads.set(comment.id, info);
					if (typeof comment.databaseId === "number") {
						threads.set(String(comment.databaseId), info);
					}
				}
			}
			const hasNext = page?.pageInfo?.hasNextPage === true;
			const endCursor = page?.pageInfo?.endCursor;
			if (!hasNext || typeof endCursor !== "string" || endCursor.length === 0 || endCursor === after) {
				break;
			}
			after = endCursor;
		}
		const body = JSON.stringify([...threads.entries()]);
		const condition = this.applyConditionalRead(key, body, options?.fresh ?? false);
		if (condition === "not_modified") {
			return { kind: "not_modified" };
		}
		return { kind: "ok_threads", threads };
	}
}

const THREADS_QUERY = `
query($nodeId: ID!, $after: String) {
  node(id: $nodeId) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          deleted
          comments(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              databaseId
            }
          }
        }
      }
    }
  }
}
`;

const THREAD_COMMENTS_QUERY = `
query($threadId: ID!, $after: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          databaseId
        }
      }
    }
  }
}
`;

export function createGitHubGhAdapter(options: GitHubGhAdapterOptions = {}): GitHubGhAdapter {
	return new GitHubGhAdapter(options);
}
