// DIAG-2 (2a): review-lineage export snapshot — review sessions plus every
// verification-repair round, kind-tagged, de-duplicated, and sorted in
// creation order, with live tails preserved and listing gaps propagated.
import { describe, expect, it, vi } from "vitest";
import { emptyTaskEditorCallEvidence } from "../../../src/cline-sdk/cline-editor-call-evidence";
import type { ClineReviewEvidencePort } from "../../../src/cline-sdk/cline-review-session-service";
import { createClineReviewSessionService } from "../../../src/cline-sdk/cline-review-session-service";
import type { ClineLaunchConfigResolver } from "../../../src/cline-sdk/cline-session-runtime";
import {
	buildSyntheticSessionHeader,
	type ClineTaskExportSnapshot,
} from "../../../src/cline-sdk/cline-task-export-snapshot";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";

function createLineageSnapshot(
	taskId: string,
	sessionIds: string[],
	listingTruncated = false,
	enumerationErrors: string[] = [],
): ClineTaskExportSnapshot {
	return {
		kind: "task",
		taskId,
		capturedAt: 1760000000000,
		listingTruncated,
		enumerationErrors,
		segments: sessionIds.map((sessionId) => ({
			header: buildSyntheticSessionHeader({
				sessionId,
				kind: "task",
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				cwd: "/tmp/worktree",
			}),
			artifactTaskId: taskId,
			launchConfig: null,
			transcript: { status: "complete", reason: null },
			messages: [],
			liveTail: null,
			readError: null,
			toolOrigins: [],
			editorCallEvidence: emptyTaskEditorCallEvidence(),
		})),
	};
}

function createFakeSessionService(snapshotsByTaskId: Map<string, ClineTaskExportSnapshot>, summaryTaskIds: string[]) {
	const getTaskExportSnapshot = vi.fn(async (taskId: string) => snapshotsByTaskId.get(taskId) ?? null);
	const sessionService = {
		getTaskExportSnapshot,
		listSummaries: vi.fn(() => summaryTaskIds.map((taskId) => ({ taskId }))),
	} as unknown as ClineTaskSessionService;
	return { sessionService, getTaskExportSnapshot };
}

function createService(sessionService: ClineTaskSessionService) {
	return createClineReviewSessionService({
		clineTaskSessionService: sessionService,
		resolveClineLaunchConfig: vi.fn() as unknown as ClineLaunchConfigResolver,
		workspaceId: "workspace-1",
		repoPath: "/tmp/repo",
		evidence: {} as unknown as ClineReviewEvidencePort,
	});
}

const REVIEW_SESSION_ID = "task-1__review-1760000000100-aaaa1111";
const REPAIR1_SESSION_ID = "task-1__review__verification-repair-1-1760000000200-bbbb2222";
const REPAIR2_SESSION_ID = "task-1__review__verification-repair-2-1760000000300-cccc3333";

describe("ClineReviewSessionService.getSessionExportSnapshot (DIAG-2 2a)", () => {
	it("merges the review session and every verification-repair round, kind-tagged and de-duplicated", async () => {
		const liveRepair1 = createLineageSnapshot("task-1::review::verification-repair-1", [REPAIR1_SESSION_ID]);
		// The live repair-1 session additionally carries a display live tail.
		if (liveRepair1.segments[0]) {
			liveRepair1.segments[0].liveTail = {
				possibleOverlap: true,
				representation: "kanban-display",
				messages: [{ id: "live-1", role: "user", content: "live repair tail", createdAt: 5 }],
			};
		}
		const { sessionService } = createFakeSessionService(
			new Map<string, ClineTaskExportSnapshot>([
				["task-1::review", createLineageSnapshot("task-1::review", [REVIEW_SESSION_ID])],
				[
					"task-1::review::verification-repair-",
					createLineageSnapshot(
						"task-1::review::verification-repair-",
						[REPAIR1_SESSION_ID, REPAIR2_SESSION_ID],
						true,
					),
				],
				["task-1::review::verification-repair-1", liveRepair1],
			]),
			["task-1::review::verification-repair-1"],
		);
		const service = createService(sessionService);
		const snapshot = await service.getSessionExportSnapshot("task-1", { ownerPaths: ["/tmp/worktree"] });

		expect(snapshot.kind).toBe("review");
		expect(snapshot.taskId).toBe("task-1");
		expect(snapshot.listingTruncated).toBe(true);
		const segments = snapshot.segments;
		expect(segments.map((segment) => segment.header.sessionId)).toEqual([
			REVIEW_SESSION_ID,
			REPAIR1_SESSION_ID,
			REPAIR2_SESSION_ID,
		]);
		expect(segments.map((segment) => segment.header.kind)).toEqual([
			"review",
			"verification-repair",
			"verification-repair",
		]);
		// The service-scoped task ids own each session's context-artifacts.
		expect(segments.map((segment) => segment.artifactTaskId)).toEqual([
			"task-1::review",
			"task-1::review::verification-repair-1",
			"task-1::review::verification-repair-2",
		]);
		// The live tail from the specific live session survives the merge.
		expect(segments[1]?.liveTail?.messages.map((message) => message.content)).toEqual(["live repair tail"]);
	});

	it("returns an empty review snapshot when the task has never run a review", async () => {
		const { sessionService } = createFakeSessionService(new Map(), []);
		const service = createService(sessionService);
		const snapshot = await service.getSessionExportSnapshot("task-noreview", { ownerPaths: ["/tmp/worktree"] });
		expect(snapshot.kind).toBe("review");
		expect(snapshot.taskId).toBe("task-noreview");
		expect(snapshot.segments).toEqual([]);
		expect(snapshot.listingTruncated).toBe(false);
	});

	it("records per-session snapshot read failures as explicit enumeration gaps", async () => {
		const sessionService = {
			getTaskExportSnapshot: vi.fn(async (taskId: string) => {
				if (taskId === "task-1::review") {
					throw new Error("corrupted transcript store");
				}
				return null;
			}),
			listSummaries: vi.fn(() => []),
		} as unknown as ClineTaskSessionService;
		const service = createService(sessionService);
		const snapshot = await service.getSessionExportSnapshot("task-1", { ownerPaths: ["/tmp/worktree"] });
		// Decision 5: a failed read is carried into the export, never dropped.
		expect(snapshot.segments).toEqual([]);
		expect(snapshot.enumerationErrors).toEqual(["session task-1::review: corrupted transcript store"]);
	});
});
