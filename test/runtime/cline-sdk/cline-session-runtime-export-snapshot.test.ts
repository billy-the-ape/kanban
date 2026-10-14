// DIAG-2 (2a): runtime-level export snapshot of a task's session lineage —
// creation order, live-but-not-durable sessions, workspace ownership, the
// explicit listing limit (Decision 3), and corrupt-transcript gaps.
import { listSessionHistoryFromBackend } from "@clinebot/core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryClineSessionRuntime } from "../../../src/cline-sdk/cline-session-runtime";
import { buildSessionIdPrefix } from "../../../src/cline-sdk/cline-session-state";
import { ClineTurnScheduler } from "../../../src/cline-sdk/cline-turn-scheduler";
import type {
	ClineSdkPersistedMessage,
	ClineSdkSessionHost,
	ClineSdkSessionRecord,
} from "../../../src/cline-sdk/sdk-runtime-boundary";

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
		list: vi.fn(async (...[limit]: Parameters<ClineSdkSessionHost["list"]>) => {
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
	it.each(["blwzb", "blwzb::review", "blwzb::review::verification-repair-1"])(
		"does not hydrate unrelated SDK transcripts when exporting %s from a 1000-session store",
		async (taskId) => {
			const prefix = buildSessionIdPrefix(taskId);
			const records = Array.from({ length: 1000 }, (_, index) =>
				createRecord({
					sessionId: index < 4 ? `${prefix}176000000000${index}-abcdefgh` : `unrelated-${index}`,
					startedAt: new Date(1760000000000 + index).toISOString(),
					updatedAt: new Date(1760000000000 + index).toISOString(),
					cwd: index === 3 ? "/tmp/foreign-workspace" : "/tmp/worktree",
				}),
			);
			const messages = new Map(
				records
					.slice(0, 3)
					.map((record) => [
						record.sessionId,
						[{ role: "user" as const, content: "recorded transcript", sessionId: record.sessionId }],
					]),
			);
			const host = createFakeHost({ records, messages });
			const hydrationPathRead = vi.fn();
			// Use the installed SDK's real history listing, without booting a host.
			// The row mapper reads messagesPath once; hydration accesses it again
			// to read/parse the transcript. No files or real sessions are needed.
			const rows = records.map((record) => ({
				...record,
				pid: 1,
				statusLock: 0,
				updatedAt: record.updatedAt ?? record.startedAt,
				get messagesPath() {
					hydrationPathRead(record.sessionId);
					return "/missing-session-transcript.json";
				},
			}));
			host.list.mockImplementation(async (limit, options) =>
				listSessionHistoryFromBackend(
					{ listSessions: async (count) => rows.slice(0, count) },
					{ ...options, limit },
				),
			);
			// Positive control: default SDK listing really does attempt hydration
			// for a local-model-style record with no persisted cost metadata.
			await host.list(1);
			expect(hydrationPathRead).toHaveBeenCalledTimes(2);
			hydrationPathRead.mockClear();
			host.list.mockClear();

			const runtime = createRuntime(host);
			const snapshot = await runtime.getTaskExportSnapshot(taskId, { ownerPaths: ["/tmp/worktree"] });
			expect(snapshot?.segments.map((segment) => segment.messages)).toEqual([...messages.values()]);
			expect(snapshot?.listingTruncated).toBe(true);
			expect(host.list).toHaveBeenCalledWith(1000, { hydrate: false });
			expect(hydrationPathRead).toHaveBeenCalledTimes(1000);
			expect(host.readMessages.mock.calls.map(([sessionId]) => sessionId)).toEqual([...messages.keys()]);
		},
	);

	it("keeps persisted lookup and stop/clear enumeration metadata-only", async () => {
		const record = createRecord({
			sessionId: "task-1-1760000000001-aaaa1111",
			startedAt: "2026-01-01T00:00:01.000Z",
			updatedAt: "2026-01-01T00:00:02.000Z",
		});
		const host = createFakeHost({ records: [record], messages: new Map() });
		const runtime = createRuntime(host);
		expect((await runtime.readPersistedTaskSession("task-1"))?.record.sessionId).toBe(record.sessionId);
		await runtime.stopTaskSession("task-1");
		await runtime.clearTaskSessions("task-1");
		expect(host.list).toHaveBeenCalledTimes(3);
		for (const call of host.list.mock.calls) {
			expect(call).toEqual([undefined, { hydrate: false }]);
		}
		expect(host.readMessages).toHaveBeenCalledTimes(1);
		expect(host.delete).toHaveBeenCalledWith(record.sessionId);
	});

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
