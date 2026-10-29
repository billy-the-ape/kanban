// DIAG-3: authenticated full-fidelity diagnostics download route.
//
// Integration coverage: real HTTP requests flow through the shared runtime
// auth gate (remote mode with the passcode gate active) into the download
// handler, which streams the plan through the real schemaVersion 3
// serializer. The export plan builder is mocked at the API boundary; the
// workspace index and board are real, under a redirected HOME.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyTaskEditorCallEvidence } from "../../../src/cline-sdk/cline-editor-call-evidence";
import type { RuntimeTaskDiagnosticsResponse } from "../../../src/core/api-contract";
import type { TaskDiagnosticsExportV3Plan } from "../../../src/core/task-diagnostics-export-v3";
import {
	generateInternalToken,
	generatePasscode,
	INTERNAL_TOKEN_ENV,
	issueSession,
} from "../../../src/security/passcode-manager";
import { handleRuntimeHttpAuthGate } from "../../../src/server/request-auth-gate";
import {
	buildTaskDiagnosticsDownloadFileName,
	handleTaskDiagnosticsDownload,
	TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME,
	type TaskDiagnosticsDownloadDeps,
} from "../../../src/server/task-diagnostics-download";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../../src/state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../../../src/trpc/app-router";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function createDiagnosticsFixture(): RuntimeTaskDiagnosticsResponse {
	return {
		ok: true,
		task: { id: "task-1", title: "Add billing export for ACME", columnId: "review", updatedAt: 1 },
		phase: "reviewing",
		lastSuccessfulPhase: "reviewing",
		needsAttention: false,
		blockedReason: null,
		branch: "feature/x",
		commit: "abc123",
		baseRef: "main",
		baseSha: "def456",
		workspace: { worktreePath: "/tmp/worktrees/task-1/repo", exists: true },
		preservedWork: {
			status: "none",
			refName: null,
			patchPath: null,
			archivePath: null,
			latestCommit: null,
			blockedReasons: [],
			preservedAt: null,
		},
		delivery: { ok: true, receipt: null, error: null, dependentsUnlock: { allowed: false, reason: "none" } },
		review: {
			ok: true,
			status: "ready",
			handoff: {
				taskId: "task-1",
				worktreePath: "/tmp/worktrees/task-1/repo",
				repoPath: "/tmp/repo",
				startingCommit: "def456",
				latestCommit: "abc123",
				changedPaths: ["src/billing.ts"],
				untrackedPaths: [],
				planDocuments: [],
				acceptanceCriteria: ["Exports ACME invoices"],
				designDecisions: ["Use CSV"],
				testsAttempted: [],
				knownLimitations: [],
				unresolvedQuestions: [],
				createdAt: 1,
			},
			result: null,
			candidateTreeHash: "tree",
			resultMatchesTree: true,
			error: null,
			warnings: [],
			verification: null,
		},
		dispatchRecord: null,
		session: { summary: null, active: false },
		context: {
			ok: true,
			source: "unavailable",
			messageCount: null,
			estimatedMessageTokens: null,
			effectiveCapacityTokens: null,
			triggerTokens: null,
			utilizationRatio: null,
			lastCompaction: null,
			historyOmitted: false,
			omittedHistoryNotice: null,
			error: null,
		},
		actions: {
			retry_phase: { enabled: false, reason: "No failed phase to retry." },
			resume_repair: { enabled: false, reason: "No delivery to resume." },
			cancel: { enabled: false, reason: "No active session to cancel." },
			recover_workspace: { enabled: false, reason: "No preserved work for this task." },
		},
		error: null,
	};
}

function createPlanFixture(completeness: "complete" | "partial" | "unavailable"): TaskDiagnosticsExportV3Plan {
	return {
		schemaVersion: 3,
		exportedAt: "2026-10-12T10:00:00.000Z",
		capture: { capturedAt: 1760250000000, note: "Point-in-time capture for diagnostics." },
		completeness: {
			status: completeness,
			reasons: completeness === "complete" ? [] : ["no Cline session transcript is recorded for this task"],
			warnings: [],
		},
		diagnostics: createDiagnosticsFixture(),
		taskPrompt: "Add billing export for ACME",
		sessions:
			completeness === "complete"
				? [
						{
							kind: "task",
							taskId: "task-1",
							listingTruncated: false,
							transcript: { status: "complete", reason: null },
							summary: null,
							segments: [
								{
									header: {
										sessionId: "task-1-1000-abc12345",
										kind: "task",
										source: "core",
										status: "completed",
										startedAt: "2026-10-12T09:00:00.000Z",
										endedAt: "2026-10-12T09:30:00.000Z",
										updatedAt: "2026-10-12T09:30:00.000Z",
										provider: "anthropic",
										model: "claude-sonnet-4.6",
										cwd: "/tmp/worktrees/task-1/repo",
										workspaceRoot: "/tmp/worktrees/task-1/repo",
										exitCode: 0,
									},
									artifactTaskId: "task-1",
									launchConfig: null,
									transcript: { status: "complete", reason: null },
									messages: [{ role: "assistant", content: "ACME billing export implemented" }],
									liveTail: null,
									toolOrigins: [],
									toolEvidence: [],
									editorCallEvidence: emptyTaskEditorCallEvidence(),
								},
							],
						},
					]
				: [],
	};
}

interface RecordedResponse {
	status: number;
	headers: Record<string, string | null>;
	body: string;
}

interface TestServer {
	url: string;
	close: () => Promise<void>;
}

function startTestServer(deps: TaskDiagnosticsDownloadDeps): Promise<TestServer> {
	return new Promise((resolveStart, rejectStart) => {
		const server = createServer((req, res) => {
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : 0;
			const requestUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
			void (async () => {
				// Mirror the production dispatch: extracted auth gate first, then the
				// download route, then the unmatched /api/ 404.
				const gate = await handleRuntimeHttpAuthGate(req, res, requestUrl.pathname, {
					isRemoteMode: true,
					isTls: false,
				});
				if (gate.handled) {
					return;
				}
				if (requestUrl.pathname === TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME) {
					await handleTaskDiagnosticsDownload(req, res, requestUrl, deps);
					return;
				}
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
			})();
		});
		server.once("error", rejectStart);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				rejectStart(new Error("Failed to start test server."));
				return;
			}
			resolveStart({
				url: `http://localhost:${address.port}`,
				close: () =>
					new Promise<void>((resolveClose, rejectClose) => {
						server.close((error) => (error ? rejectClose(error) : resolveClose()));
					}),
			});
		});
	});
}

function request(
	serverUrl: string,
	path: string,
	init: { method?: string; cookie?: string; authorization?: string } = {},
): Promise<RecordedResponse> {
	return fetch(`${serverUrl}${path}`, {
		method: init.method ?? "GET",
		headers: {
			...(init.cookie ? { cookie: init.cookie } : {}),
			...(init.authorization ? { authorization: init.authorization } : {}),
		},
	}).then((response) =>
		response
			.text()
			.then((body) => ({ status: response.status, headers: Object.fromEntries(response.headers), body })),
	);
}

let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousInternalToken: string | undefined;
let temp: { path: string; cleanup: () => void };
let repoPath: string;
let workspaceId: string;
let sessionCookie: string;
let server: TestServerWithSpies | null = null;

beforeEach(async () => {
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	previousInternalToken = process.env[INTERNAL_TOKEN_ENV];
	temp = createTempDir("kanban-diag-download-");
	process.env.HOME = temp.path;
	process.env.USERPROFILE = temp.path;
	// The workspace index lives under the runtime home (redirected HOME).
	mkdirSync(join(temp.path, ".cline", "kanban", "workspaces"), { recursive: true });

	repoPath = join(temp.path, "repo");
	mkdirSync(repoPath);
	const init = spawnSync("git", ["init"], { cwd: repoPath, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error("Failed to initialize test git repository.");
	}

	const context = await loadWorkspaceContext(repoPath);
	workspaceId = context.workspaceId;
	await mutateWorkspaceState<void>(repoPath, (state) => ({
		board: {
			...state.board,
			columns: state.board.columns.map((column) =>
				column.id === "backlog"
					? {
							...column,
							cards: [
								...column.cards,
								{
									id: "task-1",
									title: "Add billing export for ACME",
									prompt: "Add billing export for ACME",
									startInPlanMode: false,
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
								},
							],
						}
					: column,
			),
		},
		sessions: state.sessions,
		value: undefined,
	}));

	// Activate the passcode gate so the auth gate behaves exactly as in remote mode.
	generatePasscode();
	sessionCookie = `kanban_session=${issueSession()}`;
});

afterEach(async () => {
	if (server) {
		await server.close();
		server = null;
	}
	if (previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
	}
	if (previousUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = previousUserProfile;
	}
	if (previousInternalToken === undefined) {
		delete process.env[INTERNAL_TOKEN_ENV];
	} else {
		process.env[INTERNAL_TOKEN_ENV] = previousInternalToken;
	}
	temp.cleanup();
	vi.restoreAllMocks();
});

type TestServerWithSpies = TestServer & {
	buildExportPlan: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
};

function startServer(deps: TaskDiagnosticsDownloadDeps): Promise<TestServerWithSpies> {
	const buildExportPlan = vi.fn(deps.buildExportPlan);
	const warn = vi.fn(deps.warn);
	return startTestServer({ buildExportPlan, warn }).then((started) => ({
		...started,
		buildExportPlan,
		warn,
	}));
}

function startServerWithPlan(plan: TaskDiagnosticsExportV3Plan): Promise<TestServerWithSpies> {
	return startServer({
		buildExportPlan: async (_scope: RuntimeTrpcWorkspaceScope, _taskId: string) => plan,
		warn: () => undefined,
	});
}

describe("handleTaskDiagnosticsDownload (DIAG-3)", () => {
	it("rejects unauthenticated requests with 401 before any export work", async () => {
		server = await startServerWithPlan(createPlanFixture("complete"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}&taskId=task-1`,
		);
		expect(response.status).toBe(401);
		expect(server.buildExportPlan).not.toHaveBeenCalled();
	});

	it("streams the full-fidelity bundle to an internal bearer token client", async () => {
		const token = generateInternalToken();
		server = await startServerWithPlan(createPlanFixture("complete"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}&taskId=task-1`,
			{ authorization: `Bearer ${token}` },
		);
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toContain("application/json");
		expect(response.headers["x-kanban-diagnostics-completeness"]).toBe("complete");
		const disposition = response.headers["content-disposition"] ?? "";
		expect(disposition).toMatch(/^attachment; filename="task-task-1-\d+\.json"$/);
		const bundle: {
			schemaVersion: number;
			diagnostics: { ok: boolean; task: { id: string } | null };
			taskPrompt: string | null;
			sessions: Array<{ kind: string; taskId: string; segments: Array<{ messages: Array<{ content: unknown }> }> }>;
		} = JSON.parse(response.body);
		expect(bundle.schemaVersion).toBe(3);
		expect(bundle.diagnostics.ok).toBe(true);
		expect(bundle.diagnostics.task?.id).toBe("task-1");
		expect(bundle.taskPrompt).toBe("Add billing export for ACME");
		expect(bundle.sessions.map((session) => ({ kind: session.kind, taskId: session.taskId }))).toEqual([
			{ kind: "task", taskId: "task-1" },
		]);
		expect(bundle.sessions[0]?.segments[0]?.messages[0]?.content).toBe("ACME billing export implemented");
		expect(server.buildExportPlan).toHaveBeenCalledTimes(1);
		expect(server.buildExportPlan).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId, workspacePath: repoPath }),
			"task-1",
		);
	});

	it("streams the bundle for a browser session cookie client", async () => {
		server = await startServerWithPlan(createPlanFixture("unavailable"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}&taskId=task-1`,
			{ cookie: sessionCookie },
		);
		expect(response.status).toBe(200);
		expect(response.headers["x-kanban-diagnostics-completeness"]).toBe("unavailable");
		const bundle: { schemaVersion: number; sessions: unknown[] } = JSON.parse(response.body);
		expect(bundle.schemaVersion).toBe(3);
		expect(bundle.sessions).toEqual([]);
	});

	it("returns 404 for a task that is not in the workspace board", async () => {
		server = await startServerWithPlan(createPlanFixture("complete"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}&taskId=task-unknown`,
			{ cookie: sessionCookie },
		);
		expect(response.status).toBe(404);
		expect(JSON.parse(response.body).error).toBe("Task not found in this workspace.");
		// Membership is enforced before any session/artifact filesystem read.
		expect(server.buildExportPlan).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown workspace id", async () => {
		server = await startServerWithPlan(createPlanFixture("complete"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=does-not-exist&taskId=task-1`,
			{ cookie: sessionCookie },
		);
		expect(response.status).toBe(404);
		expect(JSON.parse(response.body).error).toBe("Workspace not found.");
		expect(server.buildExportPlan).not.toHaveBeenCalled();
	});

	it("returns 400 when the taskId query parameter is missing", async () => {
		server = await startServerWithPlan(createPlanFixture("complete"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}`,
			{ cookie: sessionCookie },
		);
		expect(response.status).toBe(400);
		expect(JSON.parse(response.body).error).toBe("taskId query parameter is required.");
	});

	it("returns 405 for non-GET requests", async () => {
		server = await startServerWithPlan(createPlanFixture("complete"));
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}&taskId=task-1`,
			{ method: "POST", cookie: sessionCookie },
		);
		expect(response.status).toBe(405);
	});

	it("returns a clear 500 JSON error when export assembly fails", async () => {
		server = await startServer({
			buildExportPlan: async () => {
				throw new Error("session host unavailable");
			},
			warn: () => undefined,
		});
		const response = await request(
			server.url,
			`${TASK_DIAGNOSTICS_DOWNLOAD_PATHNAME}?workspaceId=${encodeURIComponent(workspaceId)}&taskId=task-1`,
			{ cookie: sessionCookie },
		);
		expect(response.status).toBe(500);
		expect(JSON.parse(response.body).error).toContain("session host unavailable");
		expect(server.warn).toHaveBeenCalled();
	});
});

describe("buildTaskDiagnosticsDownloadFileName (DIAG-3)", () => {
	it("sanitizes the task id but keeps the timestamp", () => {
		expect(buildTaskDiagnosticsDownloadFileName("task-1", 1760250000000)).toBe("task-task-1-1760250000000.json");
		expect(buildTaskDiagnosticsDownloadFileName("task/1..x", 123)).toBe("task-task_1__x-123.json");
	});
});
