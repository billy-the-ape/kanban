// DIAG-2 (2a): runtime-level export snapshot of a task's session lineage —
// creation order, live-but-not-durable sessions, workspace ownership, the
// explicit listing limit (Decision 3), and corrupt-transcript gaps.
import { describe, expect, it, vi } from "vitest";

import { createInMemoryClineSessionRuntime } from "../../../src/cline-sdk/cline-session-runtime";
import { ClineTurnScheduler } from "../../../src/cline-sdk/cline-turn-scheduler";
import type { ClineSdkPersistedMessage, ClineSdkSessionRecord } from "../../../src/cline-sdk/sdk-runtime-boundary";

function createRecord(input: {
	sessionId: string;
	startedAt: string;
	updatedAt: string;
	cwd?: string;
}): ClineSdkSessionRecord {
	return {
		sessionId: input.sessionId,
		source: "core",
		status: "completed",
		startedAt: input.startedAt,
		updatedAt: input.updatedAt,
		interactive: true,
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		cwd: input.cwd ?? "/tmp/worktree",
		workspaceRoot: input.cwd ?? "/tmp/worktree",
		enableTools: true,
		enableSpawn: false,
		enableTeams: false,
		isSubagent: false,
	};
}

function createNoopMcpRuntimeService() {
	return {
		createToolBundle: vi.fn(async () => ({
			tools: [],
			warnings: [],
			dispose: async () => {},
		})),
		getAuthStatuses: vi.fn(async () => []),
		authorizeServer: vi.fn(),
	};
}

function createFakeHost(input: {
	records: ClineSdkSessionRecord[];
	messages: Map<string, ClineSdkPersistedMessage[]>;
	readMessagesShouldThrow?: Set<string>;
}) {
	const sortedRecords = () => [...input.records].sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
	return {
		start: vi.fn(async (sessionInput: { config?: { sessionId?: string } }) => ({
			sessionId: sessionInput.config?.sessionId ?? "unknown-session",
		})),
		send: vi.fn(async () => ({})),
		stop: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		delete: vi.fn(async () => true),
		dispose: vi.fn(async () => {}),
		get: vi.fn(async (sessionId: string) => input.records.find((record) => record.sessionId === sessionId)),
		list: vi.fn(async (limit?: number) => {
			const all = sortedRecords();
			return limit ? all.slice(-limit) : all;
		}),
		readMessages: vi.fn(async (sessionId: string) => {
			if (input.readMessagesShouldThrow?.has(sessionId)) {
				throw new Error(`Transcript for ${sessionId} is corrupt`);
			}
			return input.messages.get(sessionId) ?? [];
		}),
		subscribe: vi.fn(() => () => {}),
	};
}

function createRuntime(host: ReturnType<typeof createFakeHost>) {
	return createInMemoryClineSessionRuntime({
		turnScheduler: new ClineTurnScheduler(async () => 1),
		createSessionHost: async () => host,
		createMcpRuntimeService: () => createNoopMcpRuntimeService(),
	});
}

describe("InMemoryClineSessionRuntime.getTaskExportSnapshot (DIAG-2 2a)", () => {
	it("exports the session lineage in creation order and includes the live bound session before its durable record exists", async () => {
		const recordA = createRecord({
			sessionId: "task-1-1760000000001-aaaa1111",
			startedAt: "2026-01-01T00:00:01.000Z",
			updatedAt: "2026-01-01T00:00:02.000Z",
		});
		const recordB = createRecord({
			sessionId: "task-1-1760000000101-bbbb2222",
			startedAt: "2026-01-01T00:00:03.000Z",
			updatedAt: "2026-01-01T00:00:04.000Z",
		});
		const host = createFakeHost({
			records: [recordB, recordA],
			messages: new Map([
				[
					"task-1-1760000000001-aaaa1111",
					[{ role: "user", content: "first session work", sessionId: "task-1-1760000000001-aaaa1111" }],
				],
				[
					"task-1-1760000000101-bbbb2222",
					[{ role: "user", content: "second session work", sessionId: "task-1-1760000000101-bbbb2222" }],
				],
			]),
		});
		const runtime = createRuntime(host);
		await runtime.startTaskSession({
			taskId: "task-1",
			cwd: "/tmp/worktree",
			prompt: "third session work",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			systemPrompt: "Test system prompt",
		});

		const snapshot = await runtime.getTaskExportSnapshot("task-1");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.kind).toBe("task");
		expect(snapshot?.taskId).toBe("task-1");
		expect(snapshot?.listingTruncated).toBe(false);
		const segmentIds = snapshot?.segments.map((segment) => segment.header.sessionId) ?? [];
		expect(segmentIds[0]).toBe("task-1-1760000000001-aaaa1111");
		expect(segmentIds[1]).toBe("task-1-1760000000101-bbbb2222");
		// The bound session has no durable record yet, so it appears as an
		// empty segment rather than vanishing from the export.
		expect(segmentIds[2]).toBe(runtime.getTaskSessionId("task-1"));
		const synthetic = snapshot?.segments[2];
		expect(synthetic?.messages).toEqual([]);
		expect(synthetic?.header.kind).toBe("task");
		// Snapshotting never pauses or clears sessions.
		expect(host.stop).not.toHaveBeenCalled();
		expect(host.delete).not.toHaveBeenCalled();
	});

	it("returns null when the task owns no sessions", async () => {
		const host = createFakeHost({ records: [], messages: new Map() });
		const runtime = createRuntime(host);
		expect(await runtime.getTaskExportSnapshot("task-empty")).toBeNull();
	});

	it("rejects sessions recorded under another workspace's path when an ownership filter is provided", async () => {
		const foreign = createRecord({
			sessionId: "task-1-1760000000001-aaaa1111",
			startedAt: "2026-01-01T00:00:01.000Z",
			updatedAt: "2026-01-01T00:00:02.000Z",
			cwd: "/tmp/other-workspace",
		});
		const host = createFakeHost({ records: [foreign], messages: new Map() });
		const runtime = createRuntime(host);
		expect(await runtime.getTaskExportSnapshot("task-1", { ownerPaths: ["/tmp/worktree"] })).toBeNull();
		// Without the ownership filter the prefix match alone includes it.
		expect((await runtime.getTaskExportSnapshot("task-1"))?.segments.length).toBe(1);
	});

	it("flags a truncated session listing when the store holds more sessions than the export limit", async () => {
		const limit = 1000;
		const records: ClineSdkSessionRecord[] = [];
		const messages = new Map<string, ClineSdkPersistedMessage[]>();
		for (let index = 0; index < limit + 1; index += 1) {
			const timestampMs = 1760000000000 + index;
			const record = createRecord({
				sessionId: `task-1-${timestampMs}-abc${String(index).padStart(5, "0")}`,
				startedAt: new Date(timestampMs).toISOString(),
				updatedAt: new Date(timestampMs + 1000).toISOString(),
			});
			records.push(record);
			messages.set(record.sessionId, []);
		}
		const host = createFakeHost({ records, messages });
		const runtime = createRuntime(host);
		const snapshot = await runtime.getTaskExportSnapshot("task-1");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.listingTruncated).toBe(true);
		// The SDK returns the newest records, so the oldest one is the gap.
		expect(snapshot?.segments.length).toBe(limit);
		expect(snapshot?.segments[0]?.header.sessionId).toBe(records[1].sessionId);
	});

	it("records an explicit gap instead of an empty transcript when the durable read fails", async () => {
		const corrupt = createRecord({
			sessionId: "task-1-1760000000001-aaaa1111",
			startedAt: "2026-01-01T00:00:01.000Z",
			updatedAt: "2026-01-01T00:00:02.000Z",
		});
		const host = createFakeHost({
			records: [corrupt],
			messages: new Map(),
			readMessagesShouldThrow: new Set(["task-1-1760000000001-aaaa1111"]),
		});
		const runtime = createRuntime(host);
		const snapshot = await runtime.getTaskExportSnapshot("task-1");
		expect(snapshot?.segments.length).toBe(1);
		expect(snapshot?.segments[0]?.transcript.status).toBe("unavailable");
		expect(snapshot?.segments[0]?.readError).toContain("corrupt");
		expect(snapshot?.segments[0]?.messages).toEqual([]);
	});
});
