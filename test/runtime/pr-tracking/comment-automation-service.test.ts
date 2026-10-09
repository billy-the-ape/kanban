import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type {
	RuntimeBoardData,
	RuntimeGitHubPrTrackingRecord,
	RuntimePrFeedbackFingerprint,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskPullRequest,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import {
	applyPrPollOutcome,
	buildCommentHandlingInstruction,
	createPrCommentAutomationService,
} from "../../../src/pr-tracking/comment-automation-service";
import type { PrFeedbackEvent } from "../../../src/pr-tracking/feedback-fingerprint";
import { computePrFeedbackFingerprint } from "../../../src/pr-tracking/feedback-fingerprint";
import type { GitHubPrSnapshot } from "../../../src/pr-tracking/github-pr-client";
import {
	createInitialPrTrackingRecord,
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

const idleCline = { getSummary: () => null } as unknown as ClineTaskSessionService;
const idleTerminal = { getSummary: () => null } as unknown as TerminalSessionManager;

async function upsertSeed(
	mutator: (record: RuntimeGitHubPrTrackingRecord) => RuntimeGitHubPrTrackingRecord,
): Promise<void> {
	await upsertPrTrackingRecord(KEY, { accessScopeId: "scope-1", pr: PR }, mutator);
}

function makeService(
	overrides: {
		workspaces?: Array<{ workspaceId: string; workspacePath: string }>;
		workspaceStates?: Map<string, RuntimeWorkspaceStateResponse>;
		snapshot?: Partial<GitHubPrSnapshot>;
		send?: (
			scope: { workspaceId: string; workspacePath: string },
			body: RuntimeTaskChatSendRequest,
		) => Promise<RuntimeTaskChatSendResponse>;
	} = {},
) {
	const workspaces = overrides.workspaces ?? [{ workspaceId: "w1", workspacePath: "/w1" }];
	const workspaceStates = overrides.workspaceStates ?? new Map<string, RuntimeWorkspaceStateResponse>();
	const sent: Array<{ scope: { workspaceId: string; workspacePath: string }; body: RuntimeTaskChatSendRequest }> = [];
	const service = createPrCommentAutomationService({
		listManagedWorkspaces: () => workspaces,
		loadWorkspaceState: async (workspacePath) => {
			const state = workspaceStates.get(workspacePath);
			if (!state) {
				throw new Error(`no state for ${workspacePath}`);
			}
			return state;
		},
		getClineTaskSessionService: async () => idleCline,
		getTerminalManager: async () => idleTerminal,
		sendTaskChatMessage: async (scope, body) => {
			sent.push({ scope, body });
			return overrides.send
				? overrides.send(scope, body)
				: { ok: true, summary: null, message: { id: "msg-1", role: "user", content: body.text, createdAt: NOW } };
		},
		getGitHubAccessScopeId: async () => "scope-1",
		ghClient: {
			fetchSnapshot: async (): Promise<GitHubPrSnapshot> => makeSnapshot(overrides.snapshot ?? {}),
		},
		now: () => NOW,
		warn: () => undefined,
	});
	return { service, sent, workspaces, workspaceStates };
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
				"Explain changes and disagreements in task chat; do not post PR comments.",
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
		expect(harness.sent[0]?.body.text).toBe(buildCommentHandlingInstruction(PR.url));

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
		expect(harness.sent[0]?.body.text).toBe(buildCommentHandlingInstruction(PR.url));

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
		expect(result.error).toContain("no failed");
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
		expect(result).toEqual({ ok: true, dispatched: true });
		const loaded = await loadPrTrackingRecord(KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.commentAutomation.dispatch?.status).toBe("failed");
		expect(loaded.record.commentAutomation.dispatch?.error).toBe("model down");
	});
});
