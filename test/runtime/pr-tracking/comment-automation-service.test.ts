import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { ClineTurnPreparation } from "../../../src/cline-sdk/cline-turn-preparation";
import type {
	RuntimeAgentId,
	RuntimeBoardData,
	RuntimeGitHubPrTrackingRecord,
	RuntimePrFeedbackFingerprint,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskPullRequest,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import { getPullRequestIdentityKey } from "../../../src/core/pull-request-links";
import {
	applyPrPollOutcome,
	buildCommentHandlingInstruction,
	createPrCommentAutomationService,
} from "../../../src/pr-tracking/comment-automation-service";
import type { refreshCommentWorktree } from "../../../src/pr-tracking/comment-git-refresh";
import type { PrFeedbackEvent } from "../../../src/pr-tracking/feedback-fingerprint";
import { computePrFeedbackFingerprint } from "../../../src/pr-tracking/feedback-fingerprint";
import type { GitHubPrSnapshot } from "../../../src/pr-tracking/github-pr-client";
import {
	createInitialPrTrackingRecord,
	getPrTrackingRecordPath,
	loadPrTrackingRecord,
	upsertPrTrackingRecord,
} from "../../../src/pr-tracking/pr-comment-record-store";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { isolateTestEnvironment } from "../../utilities/test-environment";

let env: ReturnType<typeof isolateTestEnvironment>;

beforeEach(() => {
	env = isolateTestEnvironment();
});

afterEach(() => {
	env.cleanup();
});

const PR: RuntimeTaskPullRequest = {
	provider: "github",
	host: "github.com",
	repository: "octo/repo",
	number: 42,
	url: "https://github.com/octo/repo/pull/42",
	source: "manual",
	createdAt: 1_700_000_000_000,
};
const KEY = "github|github.com|octo/repo|42";
const NOW = 1_700_000_000_000;

function makeEvent(overrides: Partial<PrFeedbackEvent> & { providerId: string }): PrFeedbackEvent {
	return {
		kind: "conversation",
		updatedAt: NOW,
		bodyDigest: "d",
		body: "b",
		...overrides,
		providerId: overrides.providerId,
	};
}

function fingerprintOf(events: PrFeedbackEvent[]): RuntimePrFeedbackFingerprint {
	const fp = computePrFeedbackFingerprint(events);
	if (fp === null) {
		throw new Error("expected a non-null fingerprint");
	}
	return fp;
}

function makeSnapshot(overrides: Partial<GitHubPrSnapshot> = {}): GitHubPrSnapshot {
	return {
		complete: true,
		authError: null,
		prState: "open",
		headSha: "abc",
		htmlUrl: PR.url,
		events: [],
		...overrides,
	};
}

function makeCard(
	overrides: {
		id: string;
		autoAddressComments?: boolean;
		pullRequests?: RuntimeTaskPullRequest[];
		agentId?: string;
	} = { id: "t1" },
): RuntimeBoardData["columns"][number]["cards"][number] {
	return {
		id: overrides.id,
		title: "do the thing",
		prompt: "do the thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: NOW,
		updatedAt: NOW,
		autoAddressComments: overrides.autoAddressComments,
		pullRequests: overrides.pullRequests,
		agentId: overrides.agentId as RuntimeBoardData["columns"][number]["cards"][number]["agentId"],
	};
}

function makeState(
	cards: Array<RuntimeBoardData["columns"][number]["cards"][number]>,
	sessions: Record<string, RuntimeTaskSessionSummary> = {},
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/state.json",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board: { columns: [{ id: "review", title: "Review", cards }], dependencies: [] },
		sessions,
		revision: 1,
	};
}

function makeSummary(
	overrides: Partial<Pick<RuntimeTaskSessionSummary, "state" | "lastOutputAt" | "agentId">> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId: "t1",
		state: overrides.state ?? "idle",
		agentId: overrides.agentId ?? null,
		workspacePath: "/w1",
		pid: null,
		startedAt: NOW - 10_000,
		updatedAt: NOW,
		lastOutputAt: overrides.lastOutputAt ?? null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

const idleCline = { getSummary: () => null, listSummaries: () => [] } as unknown as ClineTaskSessionService;
const idleTerminal = {
	getSummary: () => null,
	listSummaries: () => [],
	hasActiveProcess: () => false,
} as unknown as TerminalSessionManager;

async function upsertSeed(
	mutator: (record: RuntimeGitHubPrTrackingRecord) => RuntimeGitHubPrTrackingRecord,
): Promise<void> {
	await upsertPrTrackingRecord(KEY, { accessScopeId: "scope-1", pr: PR }, mutator);
}

function makeService(
	overrides: {
		deferPreparation?: boolean;
		refreshGit?: typeof refreshCommentWorktree;
		workspaces?: Array<{ workspaceId: string; workspacePath: string }>;
		workspaceStates?: Map<string, RuntimeWorkspaceStateResponse>;
		loadWorkspaceState?: (workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
		snapshot?: Partial<GitHubPrSnapshot>;
		send?: (
			scope: { workspaceId: string; workspacePath: string },
			body: RuntimeTaskChatSendRequest,
		) => Promise<RuntimeTaskChatSendResponse>;
		/** Stands in for the workspace's selected agent (default: cline). */
		selectedAgentId?: RuntimeAgentId;
		/** Stands in for the durable workspace index (default: nothing resolves). */
		resolveWorkspacePathById?: (workspaceId: string) => Promise<string | null>;
		/** Stands in for the per-workspace Cline session service (default: idle). */
		getClineTaskSessionService?: (scope: {
			workspaceId: string;
			workspacePath: string;
		}) => Promise<ClineTaskSessionService>;
		now?: () => number;
		getGitHubAccessScopeId?: () => Promise<string>;
	} = {},
) {
	const workspaces = overrides.workspaces ?? [{ workspaceId: "w1", workspacePath: "/w1" }];
	const workspaceStates = overrides.workspaceStates ?? new Map<string, RuntimeWorkspaceStateResponse>();
	const sent: Array<{ scope: { workspaceId: string; workspacePath: string }; body: RuntimeTaskChatSendRequest }> = [];
	const snapshotCalls: string[] = [];
	const preparations: ClineTurnPreparation[] = [];
	const service = createPrCommentAutomationService({
		listManagedWorkspaces: () => workspaces,
		loadWorkspaceState:
			overrides.loadWorkspaceState ??
			(async (workspacePath) => {
				const state = workspaceStates.get(workspacePath);
				if (!state) {
					throw new Error(`no state for ${workspacePath}`);
				}
				return state;
			}),
		getClineTaskSessionService: overrides.getClineTaskSessionService ?? (async () => idleCline),
		getTerminalManager: async () => idleTerminal,
		resolveWorkspacePathById: overrides.resolveWorkspacePathById,
		refreshGit: overrides.refreshGit ?? (async () => "abc"),
		sendTaskChatMessage: async (scope, body, prepare) => {
			if (prepare) {
				preparations.push(prepare);
				if (!overrides.deferPreparation && !overrides.send) {
					const text = await prepare({ cwd: "/task-worktree", signal: new AbortController().signal });
					if (text !== null) body = { ...body, text };
				}
			}
			sent.push({ scope, body });
			return overrides.send
				? overrides.send(scope, body)
				: { ok: true, summary: null, message: { id: "msg-1", role: "user", content: body.text, createdAt: NOW } };
		},
		getGitHubAccessScopeId: overrides.getGitHubAccessScopeId ?? (async () => "scope-1"),
		// Harness effective-agent resolution: the card's explicit agentId
		// stands in for the live session's agent; `selectedAgentId` stands
		// in for the workspace's selected agent (Cline by default, as in
		// the pre-gate harness behavior).
		getEffectiveTaskAgentId: async (scope, taskId) => {
			const state = workspaceStates.get(scope.workspacePath);
			const card = state
				? state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId)
				: null;
			return card?.agentId ?? overrides.selectedAgentId ?? "cline";
		},
		ghClient: {
			fetchSnapshot: async (): Promise<GitHubPrSnapshot> => {
				snapshotCalls.push("fetchSnapshot");
				return makeSnapshot(overrides.snapshot ?? {});
			},
		},
		now: overrides.now ?? (() => NOW),
		warn: () => undefined,
	});
	return { service, sent, workspaces, workspaceStates, snapshotCalls, preparations };
}

describe("applyPrPollOutcome", () => {
	const baseRecord = () => createInitialPrTrackingRecord({ canonicalPrKey: KEY, accessScopeId: "scope-1", pr: PR });
	const candidate = { workspaceId: "w1", workspacePath: "/w1", taskId: "t1" };
	const secondCandidate = { workspaceId: "w2", workspacePath: "/w2", taskId: "t2" };

	it("assigns the single valid candidate as owner and schedules a 120s quiet deadline", () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const next = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW,
		});
		expect(next.revision).toBe(1);
		expect(next.commentAutomation.repairOwner).toEqual({ workspaceId: "w1", taskId: "t1", revision: 1 });
		expect(next.commentAutomation.pendingCount).toBe(1);
		expect(next.commentAutomation.firstPendingAt).toBe(NOW);
		expect(next.commentAutomation.debounceDeadline).toBe(NOW + 120_000);
		// The first pending observation persists the queued intent so settle,
		// restart reconciliation, and cancellation have a durable target.
		expect(next.commentAutomation.dispatch).toMatchObject({
			attemptedAt: null,
			fingerprint: fingerprintOf([event]),
			ownerRevision: 1,
			status: "queued",
			turnRef: null,
			error: null,
		});
		expect(typeof next.commentAutomation.dispatch?.dispatchId).toBe("string");
		expect(next.taskBindings).toEqual([{ workspaceId: "w1", taskId: "t1", terminal: false }]);
	});

	it("fails a sent dispatch when ownership moves to another task", () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const fingerprint = fingerprintOf([event]);
		const record = {
			...baseRecord(),
			commentAutomation: {
				...baseRecord().commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW - 5_000,
					fingerprint,
					ownerRevision: 1,
					status: "running" as const,
					turnRef: "msg-1",
					error: null,
				},
			},
		};
		// t1 is no longer enabled; t2 is now the only candidate.
		const next = applyPrPollOutcome(record, {
			candidates: [secondCandidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW,
		});
		expect(next.commentAutomation.repairOwner).toMatchObject({ workspaceId: "w2", taskId: "t2" });
		expect(next.commentAutomation.dispatch?.status).toBe("failed");
		expect(next.commentAutomation.dispatch?.error).toContain("repair owner changed");
	});

	it("caps the deadline at 600s from the first pending observation", () => {
		const first = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const record = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [first] }),
			nowMs: NOW,
		});
		// A much later edit: 120s after the edit would exceed the 600s cap.
		const edited = makeEvent({ providerId: "conversation-1", updatedAt: NOW + 500_000 });
		const next = applyPrPollOutcome(record, {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [edited] }),
			nowMs: NOW + 500_000,
		});
		expect(next.commentAutomation.debounceDeadline).toBe(NOW + 600_000);
		expect(next.commentAutomation.firstPendingAt).toBe(NOW);
	});

	it("blocks the owner and cancels pending scheduling when several candidates remain", () => {
		const event = makeEvent({ providerId: "conversation-1" });
		const next = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate, secondCandidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW,
		});
		expect(next.commentAutomation.repairOwner).toBeNull();
		expect(next.commentAutomation.pendingFeedbackFingerprint).toBeNull();
		expect(next.commentAutomation.debounceDeadline).toBeNull();
		expect(next.taskBindings.map((binding) => binding.taskId).sort()).toEqual(["t1", "t2"]);
	});

	it("cancels the queued intent on terminal PR observation while the owner stays held", () => {
		const event = makeEvent({ providerId: "conversation-1" });
		let record = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW,
		});
		record = {
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: null,
					fingerprint: fingerprintOf([event]),
					ownerRevision: 1,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		};
		const after = applyPrPollOutcome(record, {
			candidates: [candidate],
			snapshot: makeSnapshot({ prState: "merged" }),
			nowMs: NOW + 1_000,
		});
		expect(after.commentAutomation.repairOwner).toEqual({ workspaceId: "w1", taskId: "t1", revision: 1 });
		expect(after.commentAutomation.pendingFeedbackFingerprint).toBeNull();
		expect(after.commentAutomation.debounceDeadline).toBeNull();
		expect(after.commentAutomation.dispatch).toBeNull();
	});

	it("treats a duplicate poll as a no-op (no revision bump)", () => {
		const event = makeEvent({ providerId: "conversation-1" });
		const once = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW,
		});
		const again = applyPrPollOutcome(once, {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW + 60_000,
		});
		expect(again).toBe(once);
	});

	it("keeps an in-flight dispatch untouched while extending the deadline for new feedback", () => {
		const first = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const fingerprint = fingerprintOf([first]);
		let record = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [first] }),
			nowMs: NOW,
		});
		record = {
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: null,
					fingerprint,
					ownerRevision: 1,
					status: "running",
					turnRef: null,
					error: null,
				},
			},
		};
		const newer = makeEvent({ providerId: "conversation-2", updatedAt: NOW + 30_000 });
		const next = applyPrPollOutcome(record, {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [first, newer] }),
			nowMs: NOW + 30_000,
		});
		expect(next.commentAutomation.dispatch).toEqual(record.commentAutomation.dispatch);
		expect(next.commentAutomation.pendingCount).toBe(2);
		expect(next.commentAutomation.debounceDeadline).toBe(NOW + 150_000);
	});

	it("keeps a failed dispatch sticky: tracks pending without scheduling a deadline", () => {
		const event = makeEvent({ providerId: "conversation-1" });
		let record = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [event] }),
			nowMs: NOW,
		});
		record = {
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW,
					fingerprint: fingerprintOf([event]),
					ownerRevision: 1,
					status: "failed",
					turnRef: null,
					error: "boom",
				},
			},
		};
		const extra = makeEvent({ providerId: "conversation-2", updatedAt: NOW + 5_000 });
		const next = applyPrPollOutcome(record, {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [event, extra] }),
			nowMs: NOW + 5_000,
		});
		expect(next.commentAutomation.dispatch?.status).toBe("failed");
		expect(next.commentAutomation.pendingCount).toBe(2);
		expect(next.commentAutomation.debounceDeadline).toBeNull();
	});

	it("does not replay dispatched feedback that disappears (watermark preserved)", () => {
		const dispatched = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const fp = fingerprintOf([dispatched]);
		let record = applyPrPollOutcome(baseRecord(), {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [dispatched] }),
			nowMs: NOW,
		});
		record = {
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				lastDispatchedFeedbackFingerprint: fp,
				pendingFeedbackFingerprint: null,
				pendingCount: null,
				debounceDeadline: null,
				firstPendingAt: null,
			},
		};
		// The dispatched feedback is gone; nothing else exists. No pending.
		const after = applyPrPollOutcome(record, {
			candidates: [candidate],
			snapshot: makeSnapshot({ events: [] }),
			nowMs: NOW + 60_000,
		});
		expect(after.commentAutomation.pendingCount).toBeNull();
		expect(after.commentAutomation.lastDispatchedFeedbackFingerprint).toEqual(fp);
	});
});

describe("PrCommentAutomationService", () => {
	const scope = { workspaceId: "w1", workspacePath: "/w1" };

	it("builds the exact fixed instruction", () => {
		expect(buildCommentHandlingInstruction(PR.url)).toBe(
			[
				`Address comments on the linked PR: ${PR.url}.`,
				"Check the feedback against the current code and original task requirements.",
				"Fix valid issues, explain any disagreements, and update the same PR.",
				"When you post a PR comment, review, or reply, keep its API response (full JSON) or returned comment/review URL visible in the tool result — do not filter it to just `.id`/`.body`, suppress it, or mix it with unrelated output; post one publication per tool result where practical.",
				"Explain changes and disagreements in PR comments and within task chat.",
			].join(" "),
		);
	});

	it("surfaces a neutral state for a disabled task", async () => {
		const harness = makeService({
			workspaceStates: new Map([["/w1", makeState([makeCard({ id: "t1" })])]]),
		});
		const result = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(result.ok).toBe(true);
		expect(result.state.enabled).toBe(false);
		expect(result.state.pendingCount).toBe(0);
	});

	it("blocks non-Cline tasks in v1", async () => {
		const harness = makeService({
			workspaceStates: new Map([
				[
					"/w1",
					makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR], agentId: "claude" })]),
				],
			]),
		});
		const result = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(result.ok).toBe(true);
		expect(result.state.enabled).toBe(true);
		expect(result.state.supported).toBe(false);
		expect(result.state.blocker).toContain("Cline");
	});

	it("does not subscribe a task whose workspace-selected agent is not Cline", async () => {
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			selectedAgentId: "claude",
			snapshot: { events: [makeEvent({ providerId: "conversation-1" })] },
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		const result = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("unreachable");
		}
		expect(result.state.enabled).toBe(true);
		expect(result.state.supported).toBe(false);
		expect(result.state.blocker).toContain("Cline");
	});

	it("blocks tasks without exactly one github.com PR", async () => {
		const none = makeService({
			workspaceStates: new Map([["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true })])]]),
		});
		const noPr = await none.service.getTaskPrTrackingState(scope, "t1");
		expect(noPr.ok).toBe(true);
		expect(noPr.state.blocker).toContain("Link a github.com pull request");

		const secondPr = { ...PR, number: 43, url: "https://github.com/octo/repo/pull/43" };
		const many = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR, secondPr] })])],
			]),
		});
		const multi = await many.service.getTaskPrTrackingState(scope, "t1");
		expect(multi.ok).toBe(true);
		expect(multi.state.blocker).toContain("exactly one");
	});

	it("surfaces pending count, deadline, and dispatch from the durable record", async () => {
		const event = makeEvent({ providerId: "conversation-1" });
		const fingerprint = computePrFeedbackFingerprint([event]);
		expect(fingerprint).not.toBeNull();
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: fingerprint,
				pendingCount: 1,
				firstPendingAt: NOW,
				debounceDeadline: NOW + 120_000,
			},
		}));
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
		});
		const result = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(result.ok).toBe(true);
		expect(result.state.enabled).toBe(true);
		expect(result.state.pendingCount).toBe(1);
		expect(result.state.pendingDeadline).toBe(NOW + 120_000);
		expect(result.state.resumable).toBe(false);
	});

	it("shows a visible blocker when several tasks have comment handling enabled", async () => {
		const harness = makeService({
			workspaces: [
				{ workspaceId: "w1", workspacePath: "/w1" },
				{ workspaceId: "w2", workspacePath: "/w2" },
			],
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
				["/w2", makeState([makeCard({ id: "t2", autoAddressComments: true, pullRequests: [PR] })])],
			]),
		});
		await harness.service.refreshWorkspace({ workspaceId: "w1", workspacePath: "/w1" });
		await harness.service.refreshWorkspace({ workspaceId: "w2", workspacePath: "/w2" });
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [
				{ workspaceId: "w1", taskId: "t1", terminal: false },
				{ workspaceId: "w2", taskId: "t2", terminal: false },
			],
		}));
		const result = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(result.ok).toBe(true);
		expect(result.state.blocker).toContain("Choose one repair owner");
	});

	it("settles a due pending observation from a tick and sends exactly one instruction", async () => {
		// Seeded so the recomputed deadline stays in the past:
		// watermark NOW-471s + 120s = NOW-351s; firstPendingAt NOW-590s + 600s = NOW+10s.
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		const fingerprint = fingerprintOf([event]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: fingerprint,
				pendingCount: 1,
				firstPendingAt: NOW - 590_000,
				debounceDeadline: NOW - 351_000,
			},
		}));
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.scope).toMatchObject(scope);
		expect(harness.sent[0]?.body.taskId).toBe("t1");
		expect(harness.sent[0]?.body.mode).toBe("act");
		expect(harness.sent[0]?.body.text).toContain(buildCommentHandlingInstruction(PR.url));

		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		const automation = loaded.record.commentAutomation;
		expect(automation.dispatch?.status).toBe("running");
		expect(automation.dispatch?.turnRef).toBe("msg-1");
		expect(automation.dispatch?.attemptedAt).not.toBeNull();
		expect(automation.pendingFeedbackFingerprint).toBeNull();
		expect(automation.pendingCount).toBeNull();
		expect(automation.lastDispatchedFeedbackFingerprint).toEqual(fingerprint);
	});

	it("restarts the quiet window at settle when feedback arrived after the last poll", async () => {
		const first = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const snapshot: Partial<GitHubPrSnapshot> = { events: [first] };
		let clock = NOW;
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot,
			now: () => clock,
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		// Past the 60s + 5s jitter poll interval: this tick polls again, so
		// the next poll is due no earlier than NOW + 126s.
		clock = NOW + 66_000;
		await harness.service.runTick();
		expect(harness.snapshotCalls).toHaveLength(2);
		expect(harness.sent).toHaveLength(0);
		// A second comment lands between polls; the next poll is not due
		// before the persisted deadline (NOW + 120s), so only settle sees it.
		const second = makeEvent({ providerId: "conversation-2", updatedAt: NOW + 110_000 });
		snapshot.events = [first, second];
		clock = NOW + 120_000;
		await harness.service.runTick();
		expect(harness.snapshotCalls).toHaveLength(3);
		expect(harness.sent).toHaveLength(0);
		const loaded = await loadPrTrackingRecord(KEY);
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.commentAutomation.debounceDeadline).toBe(NOW + 230_000);
		expect(loaded.record.commentAutomation.pendingCount).toBe(2);
		clock = NOW + 231_000;
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
	});

	it("backs off polling when the record write throws", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const recordPath = getPrTrackingRecordPath(KEY);
		await mkdir(dirname(recordPath), { recursive: true });
		await writeFile(recordPath, "{ not json", "utf8");
		let clock = NOW;
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
			now: () => clock,
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.snapshotCalls).toHaveLength(1);
		// Regression: a malformed record made every 10s tick re-poll GitHub.
		clock += 10_000;
		await harness.service.runTick();
		clock += 10_000;
		await harness.service.runTick();
		expect(harness.snapshotCalls).toHaveLength(1);
	});

	it("never re-sends a queued dispatch whose send was already attempted", async () => {
		// The post-send write failed (or a restart left the record behind):
		// the dispatch is still queued but attemptedAt is set.
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		const fingerprint = fingerprintOf([event]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: fingerprint,
				pendingCount: 1,
				firstPendingAt: NOW - 590_000,
				debounceDeadline: NOW - 351_000,
				dispatch: {
					dispatchId: "d-attempted",
					attemptedAt: NOW - 60_000,
					fingerprint,
					ownerRevision: 1,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		}));
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		const loaded = await loadPrTrackingRecord(KEY);
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.commentAutomation.dispatch?.status).toBe("failed");
		expect(loaded.record.commentAutomation.dispatch?.error).toContain("outcome is unknown");
	});

	it("sends one instruction when two Resumes race", async () => {
		const dispatched = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 10_000 });
		const dispatchedFp = fingerprintOf([dispatched]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: dispatchedFp,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW - 5_000,
					fingerprint: dispatchedFp,
					ownerRevision: 1,
					status: "failed",
					turnRef: null,
					error: "boom",
				},
			},
		}));
		const newer = makeEvent({ providerId: "conversation-9", updatedAt: NOW });
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [dispatched, newer] },
		});
		const results = await Promise.all([
			harness.service.resumeCommentHandling(scope, "t1"),
			harness.service.resumeCommentHandling(scope, "t1"),
		]);
		expect(harness.sent).toHaveLength(1);
		expect(results.filter((result) => result.dispatched)).toHaveLength(1);
		// A later Resume after the send landed does not send again either.
		expect((await harness.service.resumeCommentHandling(scope, "t1")).dispatched).toBe(false);
		expect(harness.sent).toHaveLength(1);
	});

	it("does not send twice when ticks overlap", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		const fingerprint = fingerprintOf([event]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: fingerprint,
				pendingCount: 1,
				firstPendingAt: NOW - 590_000,
				debounceDeadline: NOW - 351_000,
			},
		}));
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
		});
		await harness.service.refreshWorkspace(scope);
		const first = harness.service.runTick();
		const second = harness.service.runTick();
		await Promise.all([first, second]);
		expect(harness.sent).toHaveLength(1);
	});

	it("does not call fetchSnapshot from settle when there is no pending feedback", async () => {
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
		});
		await harness.service.refreshWorkspace(scope);
		// The initial poll observes no feedback, so no deadline is scheduled
		// and the next poll is deferred ~60s.
		await harness.service.runTick();
		expect(harness.snapshotCalls).toHaveLength(1);
		// Later ticks: the poll is backed off and the idle settle must return
		// before fetching a snapshot (no gh API calls to re-derive "nothing").
		await harness.service.runTick();
		await harness.service.runTick();
		expect(harness.snapshotCalls).toHaveLength(1);
		expect(harness.sent).toHaveLength(0);
	});

	it("cancels the pending schedule and queued intent when the only enabled task is disabled", async () => {
		const event = makeEvent({ providerId: "conversation-1" });
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		let loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		// Sanity: the first poll scheduled the debounce and queued intent.
		expect(loaded.record.commentAutomation.debounceDeadline).toBe(NOW + 120_000);
		expect(loaded.record.commentAutomation.dispatch?.status).toBe("queued");

		// Disable the only enabled task and rescan: the record must be cleared
		// so a later re-enable starts a fresh quiet window.
		harness.workspaceStates.set("/w1", makeState([makeCard({ id: "t1" })]));
		await harness.service.refreshWorkspace(scope);
		loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		const automation = loaded.record.commentAutomation;
		expect(automation.pendingFeedbackFingerprint).toBeNull();
		expect(automation.pendingCount).toBeNull();
		expect(automation.debounceDeadline).toBeNull();
		expect(automation.firstPendingAt).toBeNull();
		expect(automation.dispatch).toBeNull();
	});

	it("does not reset the pending schedule while another candidate remains", async () => {
		const event = makeEvent({ providerId: "conversation-1" });
		const harness = makeService({
			workspaces: [
				{ workspaceId: "w1", workspacePath: "/w1" },
				{ workspaceId: "w2", workspacePath: "/w2" },
			],
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		// A second workspace enables the same PR: the first owner's schedule
		// must survive the rescan; the next poll owns that decision.
		harness.workspaceStates.set(
			"/w2",
			makeState([makeCard({ id: "t2", autoAddressComments: true, pullRequests: [PR] })]),
		);
		await harness.service.refreshWorkspace({ workspaceId: "w2", workspacePath: "/w2" });
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		const automation = loaded.record.commentAutomation;
		expect(automation.debounceDeadline).toBe(NOW + 120_000);
		expect(automation.pendingCount).toBe(1);
		expect(automation.dispatch?.status).toBe("queued");
	});

	it("resume sends exactly one instruction through the normal chat send and records the running dispatch", async () => {
		const dispatched = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 10_000 });
		const dispatchedFp = fingerprintOf([dispatched]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: dispatchedFp,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW - 5_000,
					fingerprint: dispatchedFp,
					ownerRevision: 1,
					status: "failed",
					turnRef: null,
					error: "boom",
				},
			},
		}));
		const newer = makeEvent({ providerId: "conversation-9", updatedAt: NOW });
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [dispatched, newer] },
		});
		const result = await harness.service.resumeCommentHandling(scope, "t1");
		expect(result).toEqual({ ok: true, dispatched: true });
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.scope).toMatchObject(scope);
		expect(harness.sent[0]?.body.taskId).toBe("t1");
		expect(harness.sent[0]?.body.mode).toBe("act");
		expect(harness.sent[0]?.body.text).toContain(buildCommentHandlingInstruction(PR.url));

		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		const automation = loaded.record.commentAutomation;
		expect(automation.dispatch?.status).toBe("running");
		expect(automation.dispatch?.turnRef).toBe("msg-1");
		expect(automation.dispatch?.attemptedAt).not.toBeNull();
		expect(automation.pendingFeedbackFingerprint).toBeNull();
		expect(automation.pendingCount).toBeNull();
		// The new snapshot aggregate is the dispatched watermark.
		expect(automation.lastDispatchedFeedbackFingerprint).toEqual(computePrFeedbackFingerprint([dispatched, newer]));
	});

	it("resume closes the failure without sending when no feedback remains", async () => {
		const dispatched = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 10_000 });
		const dispatchedFp = fingerprintOf([dispatched]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: dispatchedFp,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW - 5_000,
					fingerprint: dispatchedFp,
					ownerRevision: 1,
					status: "failed",
					turnRef: null,
					error: "boom",
				},
			},
		}));
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [dispatched] },
		});
		const result = await harness.service.resumeCommentHandling(scope, "t1");
		expect(result).toEqual({ ok: true, dispatched: false });
		expect(harness.sent).toHaveLength(0);
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.commentAutomation.dispatch?.status).toBe("completed");
	});

	it("resume rejects non-owner tasks and tasks without a failed dispatch", async () => {
		const notOwner = makeService({
			workspaceStates: new Map([["/w1", makeState([makeCard({ id: "t1" })])]]),
		});
		expect(await notOwner.service.resumeCommentHandling(scope, "t1")).toEqual({
			ok: false,
			error: "Comment handling is not enabled for this task.",
			dispatched: false,
		});

		const noFailure = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
		});
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
			},
		}));
		const result = await noFailure.service.resumeCommentHandling(scope, "t1");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("There is nothing to resume.");
	});

	it("a failed send marks the dispatch failed with the concise error", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const eventFp = fingerprintOf([event]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW - 1,
					fingerprint: eventFp,
					ownerRevision: 1,
					status: "failed",
					turnRef: null,
					error: "earlier failure",
				},
			},
		}));
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [event] },
			send: async () => ({ ok: false, summary: null, error: "model down" }),
		});
		const result = await harness.service.resumeCommentHandling(scope, "t1");
		// The send was attempted but failed: Resume reports it, not success.
		expect(result).toEqual({ ok: false, error: "model down", dispatched: false });
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.commentAutomation.dispatch?.status).toBe("failed");
		expect(loaded.record.commentAutomation.dispatch?.error).toBe("model down");
	});

	it("resume of a failed dispatch resets the attempt history so the safety cap does not swallow it", async () => {
		const dispatched = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 10_000 });
		const dispatchedFp = fingerprintOf([dispatched]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: dispatchedFp,
				// The fifth attempt in the window failed; the cap has not
				// tripped yet, so the record is not paused.
				autoSendAttempts: [1, 2, 3, 4, 5].map((i) => ({ dispatchId: `d${i}`, attemptedAt: NOW - i * 60_000 })),
				autoSendPaused: false,
				dispatch: {
					dispatchId: "d1",
					attemptedAt: NOW - 60_000,
					fingerprint: dispatchedFp,
					ownerRevision: 1,
					status: "failed",
					turnRef: null,
					error: "boom",
				},
			},
		}));
		const newer = makeEvent({ providerId: "conversation-9", updatedAt: NOW });
		const harness = makeService({
			workspaceStates: new Map([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
			]),
			snapshot: { events: [dispatched, newer] },
		});
		expect(await harness.service.resumeCommentHandling(scope, "t1")).toEqual({ ok: true, dispatched: true });
		expect(harness.sent).toHaveLength(1);
		const loaded = await loadPrTrackingRecord(KEY);
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.commentAutomation.autoSendPaused).toBe(false);
		expect(loaded.record.commentAutomation.autoSendAttempts).toHaveLength(1);
		expect(loaded.record.commentAutomation.dispatch?.status).toBe("running");
	});
});

describe("COMMENT-0 publication capture", () => {
	const scope = { workspaceId: "w1", workspacePath: "/w1" };
	const cardState = () =>
		new Map<string, RuntimeWorkspaceStateResponse>([
			["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])],
		]);

	const toolEvent = (
		overrides: {
			phase?: "started" | "finished";
			commands?: string[];
			output?: string | null;
			error?: string | null;
			toolCallId?: string | null;
		} = {},
	) => ({
		workspaceId: "w1",
		workspacePath: "/w1",
		taskId: "t1",
		phase: (overrides.phase ?? "finished") as "started" | "finished",
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: "run_command",
		commands: overrides.commands ?? ["gh pr comment -b 'addressing review'"],
		output: overrides.output ?? null,
		error: overrides.error ?? null,
	});

	const load = async (): Promise<RuntimeGitHubPrTrackingRecord> => {
		const loaded = await loadPrTrackingRecord(KEY);
		if (loaded.status !== "ok") {
			throw new Error(`record unavailable: ${loaded.status}`);
		}
		return loaded.record;
	};

	const seedOwner = () =>
		upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
			},
		}));

	const seedRunningDispatch = (fingerprint: RuntimePrFeedbackFingerprint) =>
		upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: fingerprint,
				dispatch: {
					dispatchId: "d-live",
					attemptedAt: NOW - 5_000,
					fingerprint,
					ownerRevision: 1,
					status: "running",
					turnRef: null,
					error: null,
				},
			},
		}));

	it("excludes recorded implementation replies from pending feedback and sends once", async () => {
		const reviewer = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		const reply = makeEvent({ providerId: "conversation-9", updatedAt: NOW - 100_000 });
		await seedOwner();
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: { ...record.commentAutomation.publication, published: [{ kind: "conversation", id: 9 }] },
			},
		}));
		const harness = makeService({ workspaceStates: cardState(), snapshot: { events: [reviewer, reply] } });
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		// One follow-up for the reviewer feedback: the recorded reply is
		// excluded, so the sent batch is the reviewer event only.
		expect(harness.sent).toHaveLength(1);
		let record = await load();
		expect(record.commentAutomation.pendingCount).toBeNull();
		expect(record.commentAutomation.lastDispatchedFeedbackFingerprint).toEqual(fingerprintOf([reviewer]));
		// A later poll with the same events creates no new scheduling and no
		// second send: the recorded reply never re-triggers handling.
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
		record = await load();
		expect(record.commentAutomation.pendingCount).toBeNull();
	});

	it("keeps another reviewer using the same account eligible", async () => {
		const first = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const second = makeEvent({ providerId: "conversation-2", updatedAt: NOW });
		await seedOwner();
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: { ...record.commentAutomation.publication, published: [{ kind: "conversation", id: 1 }] },
			},
		}));
		const harness = makeService({ workspaceStates: cardState(), snapshot: { events: [first, second] } });
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		const record = await load();
		expect(record.commentAutomation.pendingCount).toBe(1);
		expect(record.commentAutomation.pendingFeedbackFingerprint).toEqual(fingerprintOf([second]));
	});

	it("records published identities and drops scheduling caused solely by the reply", async () => {
		const reply = makeEvent({ providerId: "conversation-9", updatedAt: NOW - 471_000 });
		const replyFp = fingerprintOf([reply]);
		// A due pending schedule caused solely by the implementation reply.
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: replyFp,
				pendingCount: 1,
				firstPendingAt: NOW - 590_000,
				debounceDeadline: NOW - 351_000,
			},
		}));
		let clock = NOW;
		const harness = makeService({
			workspaceStates: cardState(),
			snapshot: { events: [reply] },
			now: () => clock,
		});
		await harness.service.refreshWorkspace(scope);

		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started" }));
		expect((await load()).commentAutomation.publication.pending).toHaveLength(1);
		// The due dispatch must wait while the capture is unresolved.
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);

		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				phase: "finished",
				output: JSON.stringify({
					id: 9,
					issue_url: "https://github.com/octo/repo/issues/42",
					html_url: "https://github.com/octo/repo/pull/42#discussion_r9",
				}),
			}),
		);
		let record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 9 }]);
		expect(record.commentAutomation.publication.pending).toEqual([]);
		// The next settle re-derives with the exclusion: the only pending
		// event was the implementation reply, so the schedule and queued
		// intent clear instead of sending.
		clock += 61_000;
		await harness.service.runTick();
		record = await load();
		expect(record.commentAutomation.pendingCount).toBeNull();
		expect(record.commentAutomation.debounceDeadline).toBeNull();
		expect(record.commentAutomation.dispatch).toBeNull();
		// A restarted service keeps the exclusion (durable record).
		const restarted = makeService({ workspaceStates: cardState(), snapshot: { events: [reply] } });
		await restarted.service.refreshWorkspace(scope);
		await restarted.service.runTick();
		expect((await load()).commentAutomation.pendingCount).toBeNull();
	});

	it("records a submitted review plus every inline comment it returned", async () => {
		const commands = ["gh pr review --comment -b 'addresses the review'"];
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started", commands }));
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				phase: "finished",
				commands,
				output: JSON.stringify({
					id: 500,
					state: "COMMENTED",
					pull_request_url: "https://github.com/octo/repo/pull/42",
					comments: [{ id: 501 }, { id: 502 }],
				}),
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([
			{ kind: "review", id: 500 },
			{ kind: "inline", id: 501 },
			{ kind: "inline", id: 502 },
		]);
		expect(record.commentAutomation.publication.pending).toEqual([]);
	});

	it("never registers identities from read-only output or quoted URLs", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh pr view 42 --json comments"],
				output: "https://github.com/octo/repo/pull/42#discussion_r7",
			}),
		);
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				toolCallId: "call-2",
				commands: ["gh api GET repos/octo/repo/pulls/42/comments"],
				output: JSON.stringify({ id: 7, body: "reviewer feedback" }),
			}),
		);
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				toolCallId: "call-3",
				commands: ["gh pr comment -b 'see https://github.com/octo/repo/pull/42#discussion_r7'"],
				output: "https://github.com/octo/repo/pull/42#issuecomment-8",
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 8 }]);
		expect(record.commentAutomation.publication.pending).toEqual([]);
	});

	it("does not record publications targeting an unlinked pull request", async () => {
		await seedOwner();
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh pr comment 43 -b 'for the other pull request'"],
				output: "https://github.com/octo/repo/pull/43#discussion_r11",
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([]);
		expect(record.commentAutomation.publication.pending).toEqual([]);
	});

	it("pauses with a visible reason when the identity is unknowable, until acknowledged", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started" }));
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "finished", output: "Done." }));
		let record = await load();
		expect(record.commentAutomation.publication.pending).toHaveLength(1);
		expect(record.commentAutomation.publication.pending[0]?.uncertain).toBe(true);
		// A duplicate finished event updates in place, never duplicates.
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "finished", output: "Done." }));
		record = await load();
		expect(record.commentAutomation.publication.pending).toHaveLength(1);

		let state = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(state.ok).toBe(true);
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toContain("publication output did not include");
		expect(state.state.resumable).toBe(true);
		expect(state.state.resumeRequiresAcknowledgment).toBe(true);

		// Resume without acknowledgment is rejected and keeps the uncertainty.
		expect(await harness.service.resumeCommentHandling(scope, "t1")).toMatchObject({ ok: false, dispatched: false });
		record = await load();
		expect(record.commentAutomation.publication.pending).toHaveLength(1);

		// Explicit acknowledgment clears it without dispatching.
		expect(await harness.service.resumeCommentHandling(scope, "t1", { acknowledgeCaptureUncertainty: true })).toEqual(
			{
				ok: true,
				dispatched: false,
			},
		);
		record = await load();
		expect(record.commentAutomation.publication.pending).toEqual([]);
		expect(record.commentAutomation.autoSendAttempts).toEqual([]);
		expect(record.commentAutomation.autoSendPaused).toBe(false);
		state = await harness.service.getTaskPrTrackingState(scope, "t1");
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toBeNull();
	});

	it("keeps dispatch, binding, and PR fields intact while recording attribution", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const fp = fingerprintOf([event]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: fp,
				pendingCount: 1,
				firstPendingAt: NOW,
				debounceDeadline: NOW + 120_000,
				lastDispatchedFeedbackFingerprint: null,
			},
		}));
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({ output: "https://github.com/octo/repo/pull/42#issuecomment-9" }),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 9 }]);
		expect(record.taskBindings).toEqual([{ workspaceId: "w1", taskId: "t1", terminal: false }]);
		expect(record.pr).toEqual(PR);
		expect(record.commentAutomation.pendingFeedbackFingerprint).toEqual(fp);
		expect(record.commentAutomation.pendingCount).toBe(1);
		expect(record.commentAutomation.debounceDeadline).toBe(NOW + 120_000);
	});

	it("allows five automatic sends per hour, pauses the sixth, and persists the pause", async () => {
		for (let i = 1; i <= 5; i += 1) {
			const event = makeEvent({ providerId: `conversation-${i}`, updatedAt: NOW - 471_000 });
			await upsertSeed((record) => ({
				...record,
				revision: record.revision + 1,
				taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
				commentAutomation: {
					...record.commentAutomation,
					repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
					dispatch:
						record.commentAutomation.dispatch !== null
							? { ...record.commentAutomation.dispatch, status: "completed" }
							: null,
				},
			}));
			const harness = makeService({ workspaceStates: cardState(), snapshot: { events: [event] } });
			await harness.service.refreshWorkspace(scope);
			await harness.service.runTick();
			expect(harness.sent).toHaveLength(1);
		}
		let record = await load();
		expect(record.commentAutomation.autoSendAttempts).toHaveLength(5);

		// Complete the fifth dispatch before observing the sixth attempt.
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				dispatch:
					record.commentAutomation.dispatch !== null
						? { ...record.commentAutomation.dispatch, status: "completed" }
						: null,
			},
		}));
		const sixth = makeEvent({ providerId: "conversation-6", updatedAt: NOW - 471_000 });
		const harness = makeService({ workspaceStates: cardState(), snapshot: { events: [sixth] } });
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		record = await load();
		expect(record.commentAutomation.autoSendPaused).toBe(true);

		const state = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(state.ok).toBe(true);
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toContain("paused after 5 attempts");
		expect(state.state.resumable).toBe(true);
		expect(state.state.resumeRequiresAcknowledgment).toBe(false);

		// A restart sees the durable pause and never auto-resumes.
		const restarted = makeService({ workspaceStates: cardState(), snapshot: { events: [sixth] } });
		await restarted.service.refreshWorkspace(scope);
		await restarted.service.runTick();
		expect(restarted.sent).toHaveLength(0);

		// Explicit Resume resets the rate-limit history without dispatching.
		expect(await restarted.service.resumeCommentHandling(scope, "t1")).toEqual({ ok: true, dispatched: false });
		record = await load();
		expect(record.commentAutomation.autoSendAttempts).toEqual([]);
		expect(record.commentAutomation.autoSendPaused).toBe(false);
	});

	it("does not resend a dispatch whose send was already attempted", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const fp = fingerprintOf([event]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: fp,
				dispatch: {
					dispatchId: "d-attempted",
					attemptedAt: NOW - 5_000,
					fingerprint: fp,
					ownerRevision: 1,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		}));
		const harness = makeService({ workspaceStates: cardState(), snapshot: { events: [event] } });
		await harness.service.start();
		// Unknown-outcome semantics are preserved: no automatic re-send; the
		// dispatch becomes a failed state that requires an explicit resume.
		expect(harness.sent).toHaveLength(0);
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("failed");
		expect(record.commentAutomation.dispatch?.error).toContain("restart interrupted");
	});

	it("advances the dispatched watermark when restart reconciliation completes an attempted dispatch", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		const fp = fingerprintOf([event]);
		// Crash between the attemptedAt write and the post-send write: the
		// batch was captured and attempted, but the watermark never landed.
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				lastDispatchedFeedbackFingerprint: null,
				pendingFeedbackFingerprint: fp,
				pendingCount: 1,
				firstPendingAt: NOW - 120_000,
				debounceDeadline: NOW - 61_000,
				dispatch: {
					dispatchId: "d-attempted",
					attemptedAt: NOW - 5_000,
					fingerprint: fp,
					ownerRevision: 1,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		}));
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				[
					"/w1",
					makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })], {
						t1: makeSummary({ state: "idle", lastOutputAt: NOW - 1_000 }),
					}),
				],
			]),
			snapshot: { events: [event] },
		});
		await harness.service.start();
		expect(harness.sent).toHaveLength(0);
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("completed");
		// The watermark advances with the completion, so the same feedback
		// cannot be requeued after the restart.
		expect(record.commentAutomation.lastDispatchedFeedbackFingerprint).toEqual(fp);
		expect(record.commentAutomation.pendingFeedbackFingerprint).toBeNull();
		expect(record.commentAutomation.pendingCount).toBeNull();
		expect(record.commentAutomation.debounceDeadline).toBeNull();
		expect(record.commentAutomation.firstPendingAt).toBeNull();
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
	});

	it("does not advance the dispatched watermark past an ignored implementation reply", async () => {
		const reviewer = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		const reply = makeEvent({ providerId: "conversation-9", updatedAt: NOW });
		const reviewerFp = fingerprintOf([reviewer]);
		await seedOwner();
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: { ...record.commentAutomation.publication, published: [{ kind: "conversation", id: 9 }] },
			},
		}));
		const harness = makeService({ workspaceStates: cardState(), snapshot: { events: [reviewer, reply] } });
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
		const record = await load();
		expect(record.commentAutomation.lastDispatchedFeedbackFingerprint).toEqual(reviewerFp);
		expect(record.commentAutomation.lastDispatchedFeedbackFingerprint?.watermark).toBe(NOW - 471_000);
	});

	it("does not retrigger on inline comments submitted inside a published review", async () => {
		const reviewer = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		// The session submitted a review (id 55) carrying this inline comment
		// via a payload; only the review id was captured.
		const ownInline = makeEvent({
			kind: "inline",
			providerId: "inline-77",
			updatedAt: NOW - 460_000,
			pullRequestReviewId: 55,
		});
		// A different reviewer's inline comment (review 99) stays eligible.
		const otherInline = makeEvent({
			kind: "inline",
			providerId: "inline-78",
			updatedAt: NOW - 450_000,
			pullRequestReviewId: 99,
		});
		await seedOwner();
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: {
					...record.commentAutomation.publication,
					published: [{ kind: "review", id: 55 }],
				},
			},
		}));
		const harness = makeService({
			workspaceStates: cardState(),
			snapshot: { events: [reviewer, ownInline, otherInline] },
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
		const record = await load();
		// The batch holds the reviewer's comment and the other inline comment
		// only; the own-review inline stayed excluded.
		expect(record.commentAutomation.lastDispatchedFeedbackFingerprint).toEqual(
			fingerprintOf([reviewer, otherInline]),
		);
	});

	it("captures publications even while auto-address is disabled", async () => {
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				["/w1", makeState([makeCard({ id: "t1", pullRequests: [PR] })])],
			]),
		});
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({ output: "https://github.com/octo/repo/pull/42#issuecomment-9" }),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 9 }]);
	});

	it("pauses every linked PR with an uncertain capture when the target is ambiguous", async () => {
		const secondPr = { ...PR, number: 43, url: "https://github.com/octo/repo/pull/43" };
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR, secondPr] })])],
			]),
		});
		await harness.service.recordPrPublicationToolEvent(toolEvent());
		const record = await load();
		expect(record.commentAutomation.publication.pending).toHaveLength(1);
		expect(record.commentAutomation.publication.pending[0]?.uncertain).toBe(true);
		const second = await loadPrTrackingRecord(getPullRequestIdentityKey(secondPr));
		expect(second.status).toBe("ok");
		if (second.status !== "ok") {
			throw new Error("second record unavailable");
		}
		expect(second.record.commentAutomation.publication.pending).toHaveLength(1);
		expect(second.record.commentAutomation.publication.pending[0]?.uncertain).toBe(true);
	});

	it("ignores an explicit write that targets a PR not linked to the task", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh pr comment 43 -b 'on another PR'"],
				output: "https://github.com/octo/repo/pull/43#issuecomment-77",
			}),
		);
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).not.toBe("ok");
	});

	it("does not settle a running dispatch from stale pre-dispatch session state", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		await seedRunningDispatch(fingerprintOf([event]));
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				[
					"/w1",
					makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })], {
						t1: makeSummary({ state: "idle", lastOutputAt: NOW - 3_600_000 }),
					}),
				],
			]),
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("running");
	});

	it("completes a running dispatch once session output postdates the dispatch", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		await seedRunningDispatch(fingerprintOf([event]));
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				[
					"/w1",
					makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })], {
						t1: makeSummary({ state: "idle", lastOutputAt: NOW + 1_000 }),
					}),
				],
			]),
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("completed");
		expect(record.commentAutomation.dispatch?.error).toBeNull();
	});

	it("completes a restart-surviving dispatch with post-dispatch live evidence", async () => {
		const event = makeEvent({ providerId: "conversation-1", updatedAt: NOW });
		await seedRunningDispatch(fingerprintOf([event]));
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				[
					"/w1",
					makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })], {
						t1: makeSummary({ state: "idle", lastOutputAt: NOW + 1_000 }),
					}),
				],
			]),
		});
		await harness.service.start();
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("completed");
		expect(record.commentAutomation.dispatch?.error).toBeNull();
	});

	// Regression: startup reconciliation resolved owners only from
	// listManagedWorkspaces, so a queued/running dispatch for an indexed but
	// not-yet-loaded workspace was permanently failed at startup.
	it("keeps a queued dispatch for an indexed-but-unloaded workspace at startup", async () => {
		const fp = fingerprintOf([makeEvent({ providerId: "conversation-1", updatedAt: NOW })]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w2", taskId: "t9", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w2", taskId: "t9", revision: 1 },
				dispatch: {
					dispatchId: "d-queued-w2",
					attemptedAt: null,
					fingerprint: fp,
					ownerRevision: 1,
					status: "queued",
					turnRef: null,
					error: null,
				},
			},
		}));
		const harness = makeService({
			workspaces: [{ workspaceId: "w1", workspacePath: "/w1" }],
			workspaceStates: cardState(),
			// w2 is in the workspace index but has no loaded state yet.
			resolveWorkspacePathById: async (workspaceId) => (workspaceId === "w2" ? "/w2" : null),
		});
		await harness.service.start();
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("queued");
	});

	it("keeps a running dispatch for an indexed-but-unloaded workspace at startup", async () => {
		const fp = fingerprintOf([makeEvent({ providerId: "conversation-1", updatedAt: NOW })]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w2", taskId: "t9", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w2", taskId: "t9", revision: 1 },
				lastDispatchedFeedbackFingerprint: fp,
				dispatch: {
					dispatchId: "d-running-w2",
					attemptedAt: NOW - 5_000,
					fingerprint: fp,
					ownerRevision: 1,
					status: "running",
					turnRef: null,
					error: null,
				},
			},
		}));
		const harness = makeService({
			workspaces: [{ workspaceId: "w1", workspacePath: "/w1" }],
			workspaceStates: cardState(),
			resolveWorkspacePathById: async (workspaceId) => (workspaceId === "w2" ? "/w2" : null),
		});
		await harness.service.start();
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("running");
	});

	it("reconciles a dispatch through the workspace index when the workspace is not managed", async () => {
		const fp = fingerprintOf([makeEvent({ providerId: "conversation-1", updatedAt: NOW })]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w2", taskId: "t9", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w2", taskId: "t9", revision: 1 },
				lastDispatchedFeedbackFingerprint: fp,
				dispatch: {
					dispatchId: "d-indexed-w2",
					attemptedAt: NOW - 5_000,
					fingerprint: fp,
					ownerRevision: 1,
					status: "running",
					turnRef: null,
					error: null,
				},
			},
		}));
		const harness = makeService({
			workspaces: [{ workspaceId: "w1", workspacePath: "/w1" }],
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				["/w1", cardState().get("/w1") ?? makeState([])],
				[
					"/w2",
					makeState([makeCard({ id: "t9", autoAddressComments: true, pullRequests: [PR] })], {
						t9: makeSummary({ state: "idle", lastOutputAt: NOW + 1_000 }),
					}),
				],
			]),
			resolveWorkspacePathById: async (workspaceId) => (workspaceId === "w2" ? "/w2" : null),
		});
		await harness.service.start();
		const record = await load();
		expect(record.commentAutomation.dispatch?.status).toBe("completed");
		expect(record.commentAutomation.dispatch?.error).toBeNull();
	});

	it("reconciles a pending capture for an indexed-but-unmanaged workspace from its transcript", async () => {
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: {
					published: [],
					pending: [
						{
							captureId: "call-9",
							taskId: "t9",
							workspaceId: "w2",
							operation: "gh pr comment",
							kind: "conversation",
							target: { host: "github.com", repository: "octo/repo", number: 42 },
							startedAt: NOW - 5_000,
							uncertain: false,
							uncertainReason: null,
						},
					],
				},
			},
		}));
		const harness = makeService({
			workspaces: [{ workspaceId: "w1", workspacePath: "/w1" }],
			workspaceStates: cardState(),
			resolveWorkspacePathById: async (workspaceId) => (workspaceId === "w2" ? "/w2" : null),
			getClineTaskSessionService: async () =>
				({
					loadTaskSessionMessages: async () => [
						{
							id: "m1",
							role: "tool",
							content: "https://github.com/octo/repo/pull/42#issuecomment-77",
							createdAt: NOW,
							meta: { toolName: "run_command", hookEventName: "tool_call_end", toolCallId: "call-9" },
						},
					],
				}) as unknown as ClineTaskSessionService,
		});
		await harness.service.start();
		const record = await load();
		expect(record.commentAutomation.publication.pending).toHaveLength(0);
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 77 }]);
	});

	it("captures both bare reply ids from a compound run_command result", async () => {
		const command = [
			"gh api repos/octo/repo/pulls/42/comments/77/replies -f \"body=Addressed.\" --jq '.id'",
			"gh api repos/octo/repo/pulls/42/comments/78/replies -f \"body=Addressed.\" --jq '.id'",
		].join("\n");
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: [command],
				output: JSON.stringify([{ query: command, result: "4289427635\n4289427764", success: true }]),
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([
			{ kind: "inline", id: 4289427635 },
			{ kind: "inline", id: 4289427764 },
		]);
		expect(record.commentAutomation.publication.pending).toHaveLength(0);
	});

	it("does not capture an edit of an already posted reply, keeping its recorded identity", async () => {
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: { ...record.commentAutomation.publication, published: [{ kind: "inline", id: 99 }] },
			},
		}));
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh api --method PATCH repos/octo/repo/pulls/comments/99 -f 'body=addressed' --jq '.body'"],
				output: "Addressed, no longer an issue.",
			}),
		);
		const record = await load();
		// The recorded identity survives and the edit opened no capture.
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "inline", id: 99 }]);
		expect(record.commentAutomation.publication.pending).toHaveLength(0);
	});

	it("recovers a bare-id capture from the transcript on restart and keeps the ids excluded", async () => {
		const command = [
			"gh api repos/octo/repo/pulls/42/comments/77/replies -f \"body=Addressed.\" --jq '.id'",
			"gh api repos/octo/repo/pulls/42/comments/78/replies -f \"body=Addressed.\" --jq '.id'",
		].join("\n");
		const unresolvedCommand = "gh pr comment -R octo/repo 42 -b 'addressing other feedback'";
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: {
					published: [],
					pending: [
						{
							captureId: "call-bare",
							taskId: "t1",
							workspaceId: "w1",
							operation: "gh api",
							kind: "inline",
							target: { host: "github.com", repository: "octo/repo", number: 42 },
							startedAt: NOW - 5_000,
							uncertain: false,
							uncertainReason: null,
						},
						{
							captureId: "call-uncertain",
							taskId: "t1",
							workspaceId: "w1",
							operation: "gh pr comment",
							kind: "conversation",
							target: { host: "github.com", repository: "octo/repo", number: 42 },
							startedAt: NOW - 5_000,
							uncertain: false,
							uncertainReason: null,
						},
					],
				},
			},
		}));
		const messages = [
			{
				id: "m-bare",
				role: "tool",
				content: [
					"Tool: run_command",
					"Input:",
					JSON.stringify({ commands: [command] }),
					"Output:",
					JSON.stringify([{ query: command, result: "4289427635\n4289427764", success: true }]),
					"Duration: 1200ms",
				].join("\n"),
				createdAt: NOW,
				meta: { toolName: "run_command", hookEventName: "tool_call_end", toolCallId: "call-bare" },
			},
			{
				id: "m-uncertain",
				role: "tool",
				content: [
					"Tool: run_command",
					"Input:",
					JSON.stringify({ commands: [unresolvedCommand] }),
					"Output:",
					"posted.",
					"Duration: 300ms",
				].join("\n"),
				createdAt: NOW,
				meta: { toolName: "run_command", hookEventName: "tool_call_end", toolCallId: "call-uncertain" },
			},
		];
		const harness = makeService({
			workspaceStates: cardState(),
			getClineTaskSessionService: async () =>
				({
					loadTaskSessionMessages: async () => messages,
				}) as unknown as ClineTaskSessionService,
		});
		await harness.service.start();
		const record = await load();
		// The bare-id capture is recovered; the unrelated uncertain capture is
		// NOT cleared merely because the session completed.
		expect(record.commentAutomation.publication.pending).toHaveLength(1);
		expect(record.commentAutomation.publication.pending[0]?.captureId).toBe("call-uncertain");
		expect(record.commentAutomation.publication.published).toEqual([
			{ kind: "inline", id: 4289427635 },
			{ kind: "inline", id: 4289427764 },
		]);
		// The recovered ids stay excluded from pending feedback: a later poll
		// seeing those inline replies sends nothing.
		const replied = [
			makeEvent({ kind: "inline", providerId: "inline-4289427635", updatedAt: NOW - 1_000 }),
			makeEvent({ kind: "inline", providerId: "inline-4289427764", updatedAt: NOW - 1_000 }),
		];
		await upsertSeed((current) => ({
			...current,
			revision: current.revision + 1,
			commentAutomation: {
				...current.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
			},
		}));
		const snapshotService = makeService({
			workspaceStates: cardState(),
			snapshot: { events: replied },
			getClineTaskSessionService: async () =>
				({
					loadTaskSessionMessages: async () => messages,
				}) as unknown as ClineTaskSessionService,
		});
		await snapshotService.service.refreshWorkspace(scope);
		await snapshotService.service.runTick();
		expect(snapshotService.sent).toHaveLength(0);
	});

	it("clears a pre-fix capture for an edit command on restart without claiming the edited id", async () => {
		const editCommand = "gh api --method PATCH repos/octo/repo/pulls/comments/99 -f 'body=addressed' --jq '.body'";
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			commentAutomation: {
				...record.commentAutomation,
				publication: {
					published: [],
					pending: [
						{
							captureId: "call-edit",
							taskId: "t1",
							workspaceId: "w1",
							operation: "gh api",
							kind: "inline",
							target: { host: "github.com", repository: "octo/repo", number: 42 },
							startedAt: NOW - 5_000,
							uncertain: false,
							uncertainReason: null,
						},
					],
				},
			},
		}));
		const harness = makeService({
			workspaceStates: cardState(),
			getClineTaskSessionService: async () =>
				({
					loadTaskSessionMessages: async () => [
						{
							id: "m1",
							role: "tool",
							content: [
								"Tool: run_command",
								"Input:",
								JSON.stringify({ commands: [editCommand] }),
								"Output:",
								"Addressed, no longer an issue.",
								"Duration: 900ms",
							].join("\n"),
							createdAt: NOW,
							meta: { toolName: "run_command", hookEventName: "tool_call_end", toolCallId: "call-edit" },
						},
					],
				}) as unknown as ClineTaskSessionService,
		});
		await harness.service.start();
		const record = await load();
		// The spurious capture is cleared and the edited reviewer's item is
		// NOT claimed as implementation-published.
		expect(record.commentAutomation.publication.pending).toHaveLength(0);
		expect(record.commentAutomation.publication.published).toEqual([]);
	});

	it("captures a gh api in-thread inline reply write (…/comments/<id>/replies)", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh api -X POST repos/octo/repo/pulls/42/comments/77/replies -f body='addressed'"],
				output: JSON.stringify({
					id: 99,
					pull_request_url: "https://api.github.com/repos/octo/repo/pulls/42",
					html_url: "https://github.com/octo/repo/pull/42#discussion_r99",
					path: "src/a.ts",
					diff_hunk: "@@",
					user: { login: "octo" },
				}),
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "inline", id: 99 }]);
	});

	it("captures a gh api write with a leading-slash endpoint", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh api -X POST /repos/octo/repo/pulls/42/comments/77 -f body='inline note'"],
				output: JSON.stringify({
					id: 98,
					pull_request_url: "https://api.github.com/repos/octo/repo/pulls/42",
					html_url: "https://github.com/octo/repo/pull/42#discussion_r98",
					path: "src/a.ts",
					diff_hunk: "@@",
				}),
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "inline", id: 98 }]);
	});

	it("attributes a case-differing explicit repository selector to the linked PR", async () => {
		const upperPr: RuntimeTaskPullRequest = {
			provider: "github",
			host: "github.com",
			repository: "Octo/Repo",
			number: 42,
			url: "https://github.com/Octo/Repo/pull/42",
			source: "manual",
			createdAt: 1,
		};
		const harness = makeService({
			workspaceStates: new Map<string, RuntimeWorkspaceStateResponse>([
				["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [upperPr] })])],
			]),
		});
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh pr comment 42 -R octo/repo -b 'addressing the review'"],
				output: "https://github.com/Octo/Repo/pull/42#issuecomment-88",
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 88 }]);
	});

	it("captures a submitted review from a real response shape (no comments array)", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh pr review 42 --comment -b 'addressing the review'"],
				output: JSON.stringify({
					id: 55,
					state: "commented",
					pull_request_url: "https://api.github.com/repos/octo/repo/pulls/42",
					html_url: "https://github.com/octo/repo/pull/42",
					submitted_at: "2026-10-12T00:00:00Z",
				}),
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "review", id: 55 }]);
	});

	it("captures a gh api write that uses the -q jq filter", async () => {
		const commands = ["gh api -q .html_url -X POST repos/octo/repo/issues/42/comments -f body='addressing'"];
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started", commands }));
		expect((await load()).commentAutomation.publication.pending).toHaveLength(1);
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({ phase: "finished", commands, output: "https://github.com/octo/repo/pull/42#issuecomment-91" }),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 91 }]);
		expect(record.commentAutomation.publication.pending).toEqual([]);
	});

	it("ignores a gh api write to an endpoint that cannot create PR feedback", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh api -X POST repos/octo/repo/pulls/42/labels -f label=bug"],
				output: JSON.stringify({ id: 3, url: "https://api.github.com/repos/octo/repo/pulls/42/labels/bug" }),
			}),
		);
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).not.toBe("ok");
	});

	it("pauses with an uncertain capture for a comment-creating graphql mutation", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: ["gh api graphql -f query='mutation { addComment(input: {body: \"addressing\"}) }'"],
				output: JSON.stringify({ data: { addComment: { comment: { databaseId: 512 } } } }),
			}),
		);
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([]);
		expect(record.commentAutomation.publication.pending).toHaveLength(1);
		expect(record.commentAutomation.publication.pending[0]?.uncertain).toBe(true);
	});

	it("ignores a graphql read during a comment-handling turn", async () => {
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				commands: [
					"gh api graphql -f query='query { pullRequest { reviewThreads(first: 20) { nodes { isResolved } } } }'",
				],
				output: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
			}),
		);
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).not.toBe("ok");
	});

	it("registers only the write fragment's identity from a structured multi-fragment result", async () => {
		const write = "gh pr comment -b 'addressing'";
		const read = "gh pr view 42 --json comments";
		const output = JSON.stringify([
			{ query: write, result: "https://github.com/octo/repo/pull/42#issuecomment-9", success: true },
			{
				query: read,
				result: JSON.stringify([{ id: 7, issue_url: "https://github.com/octo/repo/issues/42" }]),
				success: true,
			},
		]);
		const harness = makeService({ workspaceStates: cardState() });
		await harness.service.recordPrPublicationToolEvent(toolEvent({ commands: [`${write} && ${read}`], output }));
		const record = await load();
		expect(record.commentAutomation.publication.published).toEqual([{ kind: "conversation", id: 9 }]);
		expect(record.commentAutomation.publication.pending).toEqual([]);
	});

	it("surfaces a stale pending capture and resumes after acknowledgment", async () => {
		const reviewer = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		const fp = fingerprintOf([reviewer]);
		await upsertSeed((record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			commentAutomation: {
				...record.commentAutomation,
				repairOwner: { workspaceId: "w1", taskId: "t1", revision: 1 },
				pendingFeedbackFingerprint: fp,
				pendingCount: 1,
				firstPendingAt: NOW - 590_000,
				debounceDeadline: NOW - 351_000,
			},
		}));
		let clock = NOW;
		const harness = makeService({
			workspaceStates: cardState(),
			snapshot: { events: [reviewer] },
			now: () => clock,
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started" }));
		// A fresh pending capture blocks the due dispatch silently.
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		let state = await harness.service.getTaskPrTrackingState(scope, "t1");
		expect(state.ok).toBe(true);
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toBeNull();

		// No finished event within the stale window: the capture becomes an
		// explicit uncertainty and the blocker surfaces.
		clock += 11 * 60_000;
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(0);
		let record = await load();
		expect(record.commentAutomation.publication.pending).toHaveLength(1);
		expect(record.commentAutomation.publication.pending[0]?.uncertain).toBe(true);
		expect(record.commentAutomation.publication.pending[0]?.uncertainReason).toContain("result never arrived");

		state = await harness.service.getTaskPrTrackingState(scope, "t1");
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toContain("result never arrived");
		expect(state.state.resumable).toBe(true);
		expect(state.state.resumeRequiresAcknowledgment).toBe(true);

		// Resume without acknowledgment is rejected; with acknowledgment it
		// clears the capture and the due dispatch proceeds.
		expect(await harness.service.resumeCommentHandling(scope, "t1")).toMatchObject({ ok: false, dispatched: false });
		expect(await harness.service.resumeCommentHandling(scope, "t1", { acknowledgeCaptureUncertainty: true })).toEqual(
			{
				ok: true,
				dispatched: false,
			},
		);
		record = await load();
		expect(record.commentAutomation.publication.pending).toEqual([]);
		clock += 61_000;
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
	});

	it("an unpersisted capture is resumable with acknowledgment and clears on Resume", async () => {
		const reviewer = makeEvent({ providerId: "conversation-1", updatedAt: NOW - 471_000 });
		await seedOwner();
		let scopeAvailable = false;
		const harness = makeService({
			workspaceStates: cardState(),
			snapshot: { events: [reviewer] },
			getGitHubAccessScopeId: async () => {
				if (!scopeAvailable) {
					throw new Error("gh auth unavailable");
				}
				return "scope-1";
			},
		});
		await harness.service.refreshWorkspace(scope);
		// The capture cannot resolve its access scope: an in-memory pause.
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started" }));
		scopeAvailable = true;
		let state = await harness.service.getTaskPrTrackingState(scope, "t1");
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toContain("could not be persisted");
		expect(state.state.resumable).toBe(true);
		expect(state.state.resumeRequiresAcknowledgment).toBe(true);

		// The offered Resume is honored: rejected without acknowledgment,
		// accepted with it, and the blocker clears.
		expect(await harness.service.resumeCommentHandling(scope, "t1")).toMatchObject({ ok: false, dispatched: false });
		expect(await harness.service.resumeCommentHandling(scope, "t1", { acknowledgeCaptureUncertainty: true })).toEqual(
			{ ok: true, dispatched: false },
		);
		state = await harness.service.getTaskPrTrackingState(scope, "t1");
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toBeNull();
		expect(state.state.resumable).toBe(false);
	});

	it("clears an unpersisted capture pause once a later capture for the PR is persisted", async () => {
		await seedOwner();
		let scopeAvailable = false;
		const harness = makeService({
			workspaceStates: cardState(),
			getGitHubAccessScopeId: async () => {
				if (!scopeAvailable) {
					throw new Error("gh auth unavailable");
				}
				return "scope-1";
			},
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.recordPrPublicationToolEvent(toolEvent({ phase: "started", toolCallId: "call-1" }));
		let state = await harness.service.getTaskPrTrackingState(scope, "t1");
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toContain("could not be persisted");

		// A later reply's capture persists (published): the in-memory pause lifts.
		scopeAvailable = true;
		await harness.service.recordPrPublicationToolEvent(
			toolEvent({
				phase: "finished",
				toolCallId: "call-2",
				output: JSON.stringify({
					id: 9,
					issue_url: "https://github.com/octo/repo/issues/42",
					html_url: "https://github.com/octo/repo/pull/42#issuecomment-9",
				}),
			}),
		);
		state = await harness.service.getTaskPrTrackingState(scope, "t1");
		if (!state.ok) {
			throw new Error("unreachable");
		}
		expect(state.state.blocker).toBeNull();
	});
});

// Regression: refreshes, ticks, and the startup reconcile are fire-and-forget
// and each reads workspace state under the workspace-index lock. A process
// that exits while one holds it leaves the lockfile behind and the next start
// fails with "Lock file is already being held".
describe("PrCommentAutomationService dispose", () => {
	const scope = { workspaceId: "w1", workspacePath: "/w1" };

	function deferredState() {
		let resolve: (state: RuntimeWorkspaceStateResponse) => void = () => undefined;
		const promise = new Promise<RuntimeWorkspaceStateResponse>((resolvePromise) => {
			resolve = resolvePromise;
		});
		return { promise, resolve };
	}

	it("waits for an in-flight workspace read before resolving", async () => {
		const read = deferredState();
		const loads: string[] = [];
		const harness = makeService({
			loadWorkspaceState: (workspacePath) => {
				loads.push(workspacePath);
				return read.promise;
			},
		});
		const refresh = harness.service.refreshWorkspace(scope);
		expect(loads).toEqual(["/w1"]);

		let disposed = false;
		const disposing = harness.service.dispose().then(() => {
			disposed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(disposed).toBe(false);

		read.resolve(makeState([]));
		await disposing;
		await refresh;
		expect(disposed).toBe(true);
	});

	it("drops refreshes and ticks requested after dispose", async () => {
		const loads: string[] = [];
		const state = makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })]);
		const harness = makeService({
			loadWorkspaceState: async (workspacePath) => {
				loads.push(workspacePath);
				return state;
			},
		});
		await harness.service.refreshWorkspace(scope);
		expect(loads).toEqual(["/w1"]);

		await harness.service.dispose();
		await harness.service.refreshWorkspace(scope);
		// The new subscription is due immediately, so a live tick would poll it.
		await harness.service.runTick();
		expect(loads).toEqual(["/w1"]);
		expect(harness.snapshotCalls).toEqual([]);
	});

	it("stops the startup reconcile from reading further workspaces once disposed", async () => {
		const firstRead = deferredState();
		const loads: string[] = [];
		const harness = makeService({
			workspaces: [
				{ workspaceId: "w1", workspacePath: "/w1" },
				{ workspaceId: "w2", workspacePath: "/w2" },
			],
			loadWorkspaceState: (workspacePath) => {
				loads.push(workspacePath);
				return workspacePath === "/w1" ? firstRead.promise : Promise.resolve(makeState([]));
			},
		});
		harness.service.start();
		await vi.waitFor(() => {
			expect(loads).toEqual(["/w1"]);
		});

		const disposing = harness.service.dispose();
		firstRead.resolve(makeState([]));
		await disposing;
		// Give a (buggy) reconcile that kept going time to reach /w2.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(loads).toEqual(["/w1"]);
	});

	it("clears the tick timer", async () => {
		vi.useFakeTimers();
		try {
			const harness = makeService();
			harness.service.start();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			await harness.service.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops waiting for stuck work after the grace period", async () => {
		vi.useFakeTimers();
		try {
			const stuck = deferredState();
			const harness = makeService({ loadWorkspaceState: () => stuck.promise });
			void harness.service.refreshWorkspace(scope);
			const disposing = harness.service.dispose();
			await vi.advanceTimersByTimeAsync(60_000);
			await disposing;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("PR repair execution freshness", () => {
	const scope = { workspaceId: "w1", workspacePath: "/w1" };
	const first = makeEvent({ providerId: "conversation-1", body: "Fix first", updatedAt: NOW - 180_000 });
	const states = () =>
		new Map([["/w1", makeState([makeCard({ id: "t1", autoAddressComments: true, pullRequests: [PR] })])]]);
	const context = () => ({ cwd: "/task-worktree", signal: new AbortController().signal });
	async function record() {
		const loaded = await loadPrTrackingRecord(KEY);
		if (loaded.status !== "ok") throw new Error("missing tracking record");
		return loaded.record.commentAutomation;
	}

	it("defers capture until admission, refreshes after 30s, and absorbs edits/new feedback into one prompt", async () => {
		let clock = NOW;
		const snapshot = { events: [first] };
		const refreshGit = vi.fn(async () => "abc");
		const harness = makeService({
			deferPreparation: true,
			workspaceStates: states(),
			snapshot,
			now: () => clock,
			refreshGit,
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect((await record()).dispatch?.status).toBe("waiting");
		expect((await record()).lastDispatchedFeedbackFingerprint).toBeNull();
		expect(refreshGit).not.toHaveBeenCalled();
		const calls = harness.snapshotCalls.length;
		clock += 30_001;
		snapshot.events = [
			{ ...first, body: "Edited first", bodyDigest: "edited" },
			makeEvent({ providerId: "inline-2", body: "New feedback", updatedAt: clock }),
		];
		const prompt = await harness.preparations[0]?.(context());
		expect(prompt).toContain("Edited first");
		expect(prompt).toContain("New feedback");
		expect(prompt).not.toContain("Fix first");
		expect(harness.snapshotCalls).toHaveLength(calls + 1);
		expect(refreshGit).toHaveBeenCalledWith("/task-worktree", expect.anything(), expect.any(AbortSignal));
		expect((await record()).lastDispatchedFeedbackFingerprint).toEqual(fingerprintOf(snapshot.events));
	});

	it("reuses a complete fresh snapshot and still verifies Git", async () => {
		const refreshGit = vi.fn(async () => "abc");
		const harness = makeService({
			deferPreparation: true,
			workspaceStates: states(),
			snapshot: { events: [first] },
			refreshGit,
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		const calls = harness.snapshotCalls.length;
		await harness.preparations[0]?.(context());
		expect(harness.snapshotCalls).toHaveLength(calls);
		expect(refreshGit).toHaveBeenCalledOnce();
	});

	it.each(["approved with no eligible feedback", "merged"])(
		"skips a queued turn that became %s without Git or watermark advancement",
		async (reason) => {
			let clock = NOW;
			const snapshot: Partial<GitHubPrSnapshot> = { events: [first] };
			const refreshGit = vi.fn(async () => "abc");
			const harness = makeService({
				deferPreparation: true,
				workspaceStates: states(),
				snapshot,
				now: () => clock,
				refreshGit,
			});
			await harness.service.refreshWorkspace(scope);
			await harness.service.runTick();
			clock += 60_000;
			snapshot.events = [];
			if (reason === "merged") snapshot.prState = "merged";
			expect(await harness.preparations[0]?.(context())).toBeNull();
			expect(refreshGit).not.toHaveBeenCalled();
			expect((await record()).dispatch?.status).toBe("completed");
			expect((await record()).lastDispatchedFeedbackFingerprint).toBeNull();
		},
	);

	it("persists a Git blocker and preserves undispatched feedback for explicit Resume", async () => {
		const harness = makeService({
			deferPreparation: true,
			workspaceStates: states(),
			snapshot: { events: [first] },
			refreshGit: async () => {
				throw new Error("Dirty worktree");
			},
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		await expect(harness.preparations[0]?.(context())).rejects.toThrow("Git refresh blocked: Dirty worktree");
		expect((await record()).dispatch).toMatchObject({ status: "failed", errorCode: "git_refresh_blocked" });
		expect((await record()).lastDispatchedFeedbackFingerprint).toBeNull();
		expect((await harness.service.getTaskPrTrackingState(scope, "t1")).state.resumable).toBe(true);
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
	});

	it("keeps later feedback pending while running without injecting more messages", async () => {
		let clock = NOW;
		const snapshot = { events: [first] };
		const harness = makeService({ deferPreparation: true, workspaceStates: states(), snapshot, now: () => clock });
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		await harness.preparations[0]?.(context());
		clock += 70_000;
		const later = makeEvent({ providerId: "conversation-2", body: "Later", updatedAt: clock });
		snapshot.events = [first, later];
		await harness.service.runTick();
		expect(harness.sent).toHaveLength(1);
		expect((await record()).pendingFeedbackFingerprint).toEqual(fingerprintOf([later]));
		expect((await record()).lastDispatchedFeedbackFingerprint).toEqual(fingerprintOf([first]));
	});
	it("restores the pre-turn boundary after an admitted failure so Resume can retry the captured batch", async () => {
		let live = makeSummary({ state: "idle" });
		const sessions = { getSummary: () => live, listSummaries: () => [live] } as unknown as ClineTaskSessionService;
		const harness = makeService({
			deferPreparation: true,
			workspaceStates: states(),
			snapshot: { events: [first] },
			getClineTaskSessionService: async () => sessions,
		});
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		await harness.preparations[0]?.(context());
		expect((await record()).lastDispatchedFeedbackFingerprint).not.toBeNull();
		live = { ...makeSummary({ state: "awaiting_review", lastOutputAt: NOW + 10 }), reviewReason: "error" };
		await harness.service.runTick();
		expect((await record()).dispatch?.status).toBe("failed");
		expect((await record()).lastDispatchedFeedbackFingerprint).toBeNull();
		expect(await harness.service.resumeCommentHandling(scope, "t1")).toEqual({ ok: true, dispatched: true });
		expect(await harness.preparations[1]?.(context())).toContain("Fix first");
	});

	it("never replays an accepted capacity-waiting repair after restart", async () => {
		const harness = makeService({ deferPreparation: true, workspaceStates: states(), snapshot: { events: [first] } });
		await harness.service.refreshWorkspace(scope);
		await harness.service.runTick();
		expect((await record()).dispatch?.status).toBe("waiting");
		const restarted = makeService({ workspaceStates: states(), snapshot: { events: [first] } });
		await restarted.service.start();
		expect(restarted.sent).toHaveLength(0);
		expect((await record()).dispatch?.status).toBe("failed");
		expect((await record()).lastDispatchedFeedbackFingerprint).toBeNull();
		await restarted.service.dispose();
	});
});
