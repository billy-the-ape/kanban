// PRLINK-9: one-shot, display-only metadata refresh of already-linked PRs.
// Isolated from the real ~/.cline by redirecting HOME (AGENTS.md).
//
// Links are server-owned: they are seeded through `recordTaskPullRequests`
// (the same server write path the runtime uses) and removed through
// `removeTaskPullRequest` under `mutateWorkspaceState`, never by hand-editing
// a whole-board save.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GitHubPrMetadataSnapshot,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskPullRequest,
} from "../../src/core/api-contract";
import { getPullRequestIdentityKey, parsePullRequestUrl } from "../../src/core/pull-request-links";
import { type RuntimeTaskPullRequestSnapshotUpdate, removeTaskPullRequest } from "../../src/core/task-board-mutations";
import type { OneShotMetadataRefreshResult } from "../../src/pr-tracking/pr-tracking-coordinator";
import { loadWorkspaceState, mutateWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import {
	refreshLinkedTaskPullRequests,
	refreshTaskPullRequestEntry,
	TASK_PULL_REQUEST_REFRESH_CONCURRENCY,
	TASK_PULL_REQUEST_REFRESH_LINK_LIMIT,
	type TaskPullRequestMetadataRefreshPort,
} from "../../src/workspace/task-pull-request-refresh";
import { recordTaskPullRequests } from "../../src/workspace/task-pull-requests";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

interface TempDirWithEnv extends ReturnType<typeof createTempDir> {
	previousHome?: string;
	previousUserProfile?: string;
}

let tempHome: TempDirWithEnv | null = null;

beforeEach(() => {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	tempHome = { ...createTempDir("kanban-task-pr-refresh-home-"), previousHome, previousUserProfile };
	process.env.HOME = tempHome.path;
	process.env.USERPROFILE = tempHome.path;
});

afterEach(() => {
	if (!tempHome) {
		return;
	}
	if (tempHome.previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = tempHome.previousHome;
	}
	if (tempHome.previousUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = tempHome.previousUserProfile;
	}
	tempHome.cleanup();
	tempHome = null;
});

function createEntry(overrides: Partial<RuntimeTaskPullRequest> = {}): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "owner/repo",
		number: 12,
		url: "https://github.com/owner/repo/pull/12",
		source: "manual",
		createdAt: 1000,
		...overrides,
	};
}

function metadata(overrides: Partial<GitHubPrMetadataSnapshot> = {}): GitHubPrMetadataSnapshot {
	return {
		accessScopeId: "scope-A",
		checkedAt: 2000,
		state: "open",
		headRepository: null,
		headRef: null,
		baseRepository: null,
		baseRef: null,
		headSha: null,
		mergedAt: null,
		mergeCommitSha: null,
		...overrides,
	};
}

function refreshedResult(overrides: Partial<OneShotMetadataRefreshResult> = {}): OneShotMetadataRefreshResult {
	return {
		outcome: "refreshed",
		checkedAt: 2000,
		metadata: metadata(),
		error: null,
		...overrides,
	};
}

function initWorkspace(workspacePath: string): void {
	mkdirSync(workspacePath, { recursive: true });
	const init = spawnSync("git", ["init"], {
		cwd: workspacePath,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${workspacePath}`);
	}
}

/**
 * Seeds a task in the given column and records the supplied links through the
 * server-owned write path (`recordTaskPullRequests`).
 */
async function seedWorkspace(
	sandboxRoot: string,
	taskId: string,
	columnId: RuntimeBoardColumnId,
	entries: RuntimeTaskPullRequest[],
): Promise<string> {
	const workspacePath = join(sandboxRoot, "project-a");
	initWorkspace(workspacePath);
	const initial = await loadWorkspaceState(workspacePath);
	const board: RuntimeBoardData = {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
	const column = board.columns.find((item) => item.id === columnId);
	if (!column) {
		throw new Error(`Unknown column ${columnId}`);
	}
	column.cards.push({
		id: taskId,
		title: "Task",
		prompt: "Task prompt",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
	});
	await saveWorkspaceState(workspacePath, { board, sessions: {}, expectedRevision: initial.revision });
	if (entries.length > 0) {
		const links = entries.map((entry) => {
			const link = parsePullRequestUrl(entry.url);
			if (!link) {
				throw new Error(`Expected ${entry.url} to parse as a pull request link`);
			}
			return link;
		});
		const first = entries[0];
		if (first === undefined) {
			throw new Error("entries must be non-empty");
		}
		const snapshot: RuntimeTaskPullRequestSnapshotUpdate | undefined =
			first.state !== undefined || first.stateCheckedAt !== undefined || first.title !== undefined
				? {
						...(first.state !== undefined ? { state: first.state } : {}),
						...(first.stateCheckedAt !== undefined ? { stateCheckedAt: first.stateCheckedAt } : {}),
						...(first.title !== undefined ? { title: first.title } : {}),
					}
				: undefined;
		await recordTaskPullRequests({
			workspacePath,
			taskId,
			links,
			source: "manual",
			...(snapshot ? { snapshot } : {}),
		});
	}
	return workspacePath;
}

interface RefreshHarness {
	workspacePath: string;
	refresh: TaskPullRequestMetadataRefreshPort;
	calls: () => string[];
}

function makeRefreshHarness(
	workspacePath: string,
	handler?: (key: string) => OneShotMetadataRefreshResult | Promise<OneShotMetadataRefreshResult>,
): RefreshHarness {
	const calls: string[] = [];
	const refresh: TaskPullRequestMetadataRefreshPort = async (canonicalPrKey) => {
		calls.push(canonicalPrKey);
		return handler ? handler(canonicalPrKey) : refreshedResult();
	};
	return { workspacePath, refresh, calls: () => calls };
}

function findCardPullRequests(
	state: { board: RuntimeBoardData },
	taskId: string,
): RuntimeTaskPullRequest[] | undefined {
	return state.board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.pullRequests;
}

async function removeRecordedLink(workspacePath: string, taskId: string, entry: RuntimeTaskPullRequest): Promise<void> {
	await mutateWorkspaceState<void>(workspacePath, (state) => {
		const result = removeTaskPullRequest(state.board, taskId, getPullRequestIdentityKey(entry));
		return { board: result.board, value: undefined, save: result.removed };
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("refreshTaskPullRequestEntry", () => {
	it("refreshes a single linked PR on a Done task by identity (never by branch)", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entry = createEntry();
			const workspacePath = await seedWorkspace(sandboxRoot, "task-done", "trash", [entry]);
			const harness = makeRefreshHarness(workspacePath);

			const result = await refreshTaskPullRequestEntry({
				workspacePath,
				taskId: "task-done",
				url: entry.url,
				refresh: harness.refresh,
			});

			expect(result.ok).toBe(true);
			expect(result.updated).toBe(1);
			expect(result.outcomes).toEqual([
				expect.objectContaining({ outcome: "refreshed", provider: "github", number: 12 }),
			]);
			expect(harness.calls()).toHaveLength(1);
			const recorded = await loadWorkspaceState(workspacePath);
			const stored = findCardPullRequests(recorded, "task-done");
			expect(stored?.[0]?.state).toBe("open");
			expect(stored?.[0]?.stateCheckedAt).toBe(2000);
		} finally {
			cleanup();
		}
	});

	it("applies a refreshed title from the same read", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entry = createEntry();
			const workspacePath = await seedWorkspace(sandboxRoot, "task-done", "trash", [entry]);
			const harness = makeRefreshHarness(workspacePath, () =>
				refreshedResult({ metadata: metadata({ title: "Fix the thing" }) }),
			);

			const result = await refreshTaskPullRequestEntry({
				workspacePath,
				taskId: "task-done",
				url: entry.url,
				refresh: harness.refresh,
			});

			expect(result.updated).toBe(1);
			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(recorded, "task-done")?.[0]?.title).toBe("Fix the thing");
		} finally {
			cleanup();
		}
	});

	it("reports unlinked identity when the URL is not recorded on the task", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entry = createEntry();
			const workspacePath = await seedWorkspace(sandboxRoot, "task-done", "trash", [entry]);
			const harness = makeRefreshHarness(workspacePath);
			const other = createEntry({ number: 99, url: "https://github.com/owner/repo/pull/99" });

			const result = await refreshTaskPullRequestEntry({
				workspacePath,
				taskId: "task-done",
				url: other.url,
				refresh: harness.refresh,
			});

			expect(result.ok).toBe(true);
			expect(result.updated).toBe(0);
			expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "unlinked", number: 99 })]);
			expect(harness.calls()).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("never queries an unsupported provider or host", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const gitlab = createEntry({
				provider: "gitlab",
				host: "gitlab.com",
				repository: "group/project",
				number: 7,
				url: "https://gitlab.com/group/project/-/merge_requests/7",
			});
			const ghe = createEntry({ host: "ghe.corp.io", number: 42, url: "https://ghe.corp.io/owner/repo/pull/42" });
			const workspacePath = await seedWorkspace(sandboxRoot, "task-mixed", "trash", [gitlab, ghe]);
			const harness = makeRefreshHarness(workspacePath);

			const gitlabResult = await refreshTaskPullRequestEntry({
				workspacePath,
				taskId: "task-mixed",
				url: gitlab.url,
				refresh: harness.refresh,
			});
			expect(gitlabResult.outcomes).toEqual([expect.objectContaining({ outcome: "unsupported" })]);

			const gheResult = await refreshTaskPullRequestEntry({
				workspacePath,
				taskId: "task-mixed",
				url: ghe.url,
				refresh: harness.refresh,
			});
			expect(gheResult.outcomes).toEqual([expect.objectContaining({ outcome: "unsupported" })]);

			expect(harness.calls()).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("propagates a sanitized provider failure without touching the board", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entry = createEntry();
			const workspacePath = await seedWorkspace(sandboxRoot, "task-done", "trash", [entry]);
			const harness = makeRefreshHarness(workspacePath, () => ({
				outcome: "failed",
				checkedAt: null,
				metadata: null,
				error: "rate_limited",
			}));

			const result = await refreshTaskPullRequestEntry({
				workspacePath,
				taskId: "task-done",
				url: entry.url,
				refresh: harness.refresh,
			});

			expect(result.ok).toBe(true);
			expect(result.updated).toBe(0);
			expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "failed", error: "rate_limited" })]);
			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(recorded, "task-done")?.[0]?.state).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("refreshLinkedTaskPullRequests", () => {
	it("refreshes every linked PR, skipping unsupported providers without querying them", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const gh12 = createEntry({ number: 12, url: "https://github.com/owner/repo/pull/12" });
			const gh13 = createEntry({ number: 13, url: "https://github.com/owner/repo/pull/13" });
			const gitlab = createEntry({
				provider: "gitlab",
				host: "gitlab.com",
				repository: "group/project",
				number: 7,
				url: "https://gitlab.com/group/project/-/merge_requests/7",
			});
			const workspacePath = await seedWorkspace(sandboxRoot, "task-multi", "trash", [gh12, gitlab, gh13]);
			const harness = makeRefreshHarness(workspacePath);

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-multi",
				refresh: harness.refresh,
			});

			expect(result.ok).toBe(true);
			expect(result.updated).toBe(2);
			// Ordered by stored link order.
			expect(result.outcomes.map((outcome) => [outcome.number, outcome.outcome])).toEqual([
				[12, "refreshed"],
				[7, "unsupported"],
				[13, "refreshed"],
			]);
			// Only the two github.com links were queried.
			expect(harness.calls()).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	it("caps the linked refresh at the link limit", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const count = TASK_PULL_REQUEST_REFRESH_LINK_LIMIT + 1;
			const entries: RuntimeTaskPullRequest[] = [];
			for (let i = 1; i <= count; i += 1) {
				entries.push(createEntry({ number: i, url: `https://github.com/owner/repo/pull/${i}` }));
			}
			const workspacePath = await seedWorkspace(sandboxRoot, "task-many", "trash", entries);
			const harness = makeRefreshHarness(workspacePath);

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-many",
				refresh: harness.refresh,
			});

			expect(result.outcomes).toHaveLength(TASK_PULL_REQUEST_REFRESH_LINK_LIMIT);
			expect(harness.calls()).toHaveLength(TASK_PULL_REQUEST_REFRESH_LINK_LIMIT);
		} finally {
			cleanup();
		}
	});

	it("bounds in-flight provider reads at the concurrency limit", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entries: RuntimeTaskPullRequest[] = [];
			for (let i = 1; i <= 10; i += 1) {
				entries.push(createEntry({ number: i, url: `https://github.com/owner/repo/pull/${i}` }));
			}
			const workspacePath = await seedWorkspace(sandboxRoot, "task-conc", "trash", entries);
			let inFlight = 0;
			let maxInFlight = 0;
			const harness = makeRefreshHarness(workspacePath, async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(20);
				inFlight -= 1;
				return refreshedResult();
			});

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-conc",
				refresh: harness.refresh,
			});

			expect(result.updated).toBe(10);
			expect(maxInFlight).toBe(TASK_PULL_REQUEST_REFRESH_CONCURRENCY);
		} finally {
			cleanup();
		}
	});

	it("reports deadline-exceeded links as failed and never retries them", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entries: RuntimeTaskPullRequest[] = [];
			for (let i = 1; i <= 4; i += 1) {
				entries.push(createEntry({ number: i, url: `https://github.com/owner/repo/pull/${i}` }));
			}
			const workspacePath = await seedWorkspace(sandboxRoot, "task-deadline", "trash", entries);
			let attempts = 0;
			const harness = makeRefreshHarness(workspacePath, async () => {
				attempts += 1;
				await sleep(200);
				return refreshedResult();
			});

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-deadline",
				refresh: harness.refresh,
				deadlineMs: 40,
			});

			expect(result.outcomes.every((outcome) => outcome.outcome === "failed")).toBe(true);
			expect(result.outcomes.every((outcome) => outcome.error === "deadline exceeded")).toBe(true);
			// Every link is attempted at most once: the deadline reports, never
			// waits and never retries.
			expect(attempts).toBeLessThanOrEqual(entries.length);
			expect(attempts).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	it("never resurrects a link removed while the read is in flight", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entry = createEntry();
			const workspacePath = await seedWorkspace(sandboxRoot, "task-rm", "trash", [entry]);
			const harness = makeRefreshHarness(workspacePath, async () => {
				// Remove the link (server-owned path) while the read is in flight.
				await removeRecordedLink(workspacePath, "task-rm", entry);
				return refreshedResult();
			});

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-rm",
				refresh: harness.refresh,
			});

			expect(result.updated).toBe(0);
			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(recorded, "task-rm")).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("applies nothing when a stale result loses to a newer stored observation", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const entry = createEntry({ state: "closed", stateCheckedAt: 5000 });
			const workspacePath = await seedWorkspace(sandboxRoot, "task-stale", "trash", [entry]);
			const harness = makeRefreshHarness(workspacePath, () =>
				refreshedResult({ metadata: metadata({ state: "open", checkedAt: 1000 }) }),
			);

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-stale",
				refresh: harness.refresh,
			});

			expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "refreshed" })]);
			expect(result.updated).toBe(0);
			const recorded = await loadWorkspaceState(workspacePath);
			expect(findCardPullRequests(recorded, "task-stale")?.[0]?.state).toBe("closed");
			expect(findCardPullRequests(recorded, "task-stale")?.[0]?.stateCheckedAt).toBe(5000);
		} finally {
			cleanup();
		}
	});

	it("returns ok with no outcomes when the task has no links", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-task-pr-refresh-ws-");
		try {
			const workspacePath = await seedWorkspace(sandboxRoot, "task-none", "trash", []);
			const harness = makeRefreshHarness(workspacePath);

			const result = await refreshLinkedTaskPullRequests({
				workspacePath,
				taskId: "task-none",
				refresh: harness.refresh,
			});

			expect(result).toEqual({ ok: true, updated: 0, outcomes: [] });
			expect(harness.calls()).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});
