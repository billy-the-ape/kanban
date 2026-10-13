// DIAG-2 (2a): the pure helpers that build the typed transcript export
// snapshot — header allowlists, the fixed-priority live tail, and the
// Decision-4 tool-origin labeling across restart segments.
import { describe, expect, it } from "vitest";
import type { ClineTaskMessage } from "../../../src/cline-sdk/cline-session-state";
import {
	buildAllowlistedSessionHeader,
	buildSessionExportLiveTail,
	buildSyntheticSessionHeader,
	type ClineTaskExportSegment,
	collectDurableToolCallIds,
	labelSegmentToolOrigins,
} from "../../../src/cline-sdk/cline-task-export-snapshot";
import type { ClineSdkPersistedMessage, ClineSdkSessionRecord } from "../../../src/cline-sdk/sdk-runtime-boundary";

function createRecord(overrides: Partial<ClineSdkSessionRecord> = {}): ClineSdkSessionRecord {
	return {
		sessionId: "task-1-1000-abc12345",
		isSubagent: false,
		source: "core",
		status: "completed",
		endedAt: "2026-10-12T10:00:05.000Z",
		exitCode: 0,
		startedAt: "2026-10-12T10:00:00.000Z",
		interactive: true,
		provider: "anthropic",
		model: "claude-sonnet-4.6",
		cwd: "/home/u/.cline/worktrees/task-1/repo",
		workspaceRoot: "/home/u/.cline/worktrees/task-1/repo",
		enableTools: true,
		enableSpawn: false,
		enableTeams: false,
		prompt: "Implement the feature",
		metadata: {
			taskId: "task-1",
			messagesPath: "/home/u/.cline/data/sessions/task-1.jsonl",
			hookPath: "/home/u/.cline/data/hooks/task-1.json",
			pid: 4242,
		},
		updatedAt: "2026-10-12T10:00:05.000Z",
		...overrides,
	};
}

function displayMessage(overrides: Partial<ClineTaskMessage>): ClineTaskMessage {
	return {
		id: `msg-${Math.random().toString(36).slice(2, 8)}`,
		role: "assistant",
		content: "text",
		createdAt: 1000,
		...overrides,
	};
}

function durableMessage(parts: Array<Record<string, unknown>>, ts?: number): ClineSdkPersistedMessage {
	const message: ClineSdkPersistedMessage = { role: "assistant", content: parts as never, sessionId: "s1" };
	if (ts !== undefined) {
		message.ts = ts;
	}
	return message;
}

describe("buildAllowlistedSessionHeader", () => {
	it("copies only the allowlisted fields", () => {
		const header = buildAllowlistedSessionHeader(createRecord(), "task");
		expect(header).toEqual({
			sessionId: "task-1-1000-abc12345",
			kind: "task",
			source: "core",
			status: "completed",
			startedAt: "2026-10-12T10:00:00.000Z",
			endedAt: "2026-10-12T10:00:05.000Z",
			updatedAt: "2026-10-12T10:00:05.000Z",
			provider: "anthropic",
			model: "claude-sonnet-4.6",
			cwd: "/home/u/.cline/worktrees/task-1/repo",
			workspaceRoot: "/home/u/.cline/worktrees/task-1/repo",
			exitCode: 0,
		});
		// Decision 6: the raw metadata object and everything it contains
		// (prompt, messagesPath, hookPath, pid) never leave the runtime.
		expect(Object.keys(header)).not.toContain("metadata");
		expect(Object.keys(header)).not.toContain("prompt");
		expect(JSON.stringify(header)).not.toContain("messagesPath");
		expect(JSON.stringify(header)).not.toContain("4242");
	});

	it("nulls optional timestamps and exit code on incomplete records", () => {
		const header = buildAllowlistedSessionHeader(
			createRecord({ startedAt: undefined, endedAt: null, updatedAt: undefined, exitCode: null } as never),
			"task",
		);
		expect(header.startedAt).toBeNull();
		expect(header.endedAt).toBeNull();
		expect(header.updatedAt).toBeNull();
		expect(header.exitCode).toBeNull();
	});
});

describe("buildSyntheticSessionHeader", () => {
	it("emits stable null timestamps and empty-string fallbacks (no live pid or prompt)", () => {
		const header = buildSyntheticSessionHeader({
			sessionId: "task-1-2000-xyz99999",
			kind: "task",
			providerId: null,
			modelId: null,
			cwd: null,
		});
		expect(header).toEqual({
			sessionId: "task-1-2000-xyz99999",
			kind: "task",
			source: "core",
			status: "running",
			startedAt: null,
			endedAt: null,
			updatedAt: null,
			provider: "",
			model: "",
			cwd: "",
			workspaceRoot: "",
			exitCode: null,
		});
	});
});

describe("buildSessionExportLiveTail", () => {
	it("returns null for an empty live list", () => {
		expect(buildSessionExportLiveTail([durableMessage([])], [])).toBeNull();
	});

	it("priority 1: starts after the latest durable ts when any durable message has one", () => {
		const durable = [
			durableMessage([{ type: "text", text: "a" }], 100),
			durableMessage([{ type: "text", text: "b" }], 500),
			durableMessage([{ type: "text", text: "c" }]),
		];
		const live = [
			displayMessage({ createdAt: 90 }),
			displayMessage({ createdAt: 490 }),
			displayMessage({ createdAt: 510 }),
			displayMessage({ createdAt: 600 }),
		];
		const tail = buildSessionExportLiveTail(durable, live);
		expect(tail?.messages.map((message) => message.createdAt)).toEqual([510, 600]);
		expect(tail?.representation).toBe("kanban-display");
		expect(tail?.possibleOverlap).toBe(true);
	});

	it("priority 2: without durable ts, starts after the last durable tool_result position", () => {
		const durable = [
			durableMessage([{ type: "tool_use", id: "t1", name: "run_command", input: {} }]),
			durableMessage([{ type: "tool_result", tool_use_id: "t1", content: "done" }]),
		];
		const live = [
			displayMessage({ role: "assistant", createdAt: 10 }),
			displayMessage({ role: "tool", createdAt: 20, meta: { toolCallId: "t1" } }),
			displayMessage({ role: "assistant", createdAt: 30 }),
		];
		const tail = buildSessionExportLiveTail(durable, live);
		expect(tail?.messages.map((message) => message.createdAt)).toEqual([30]);
	});

	it("priority 3: without durable ts and no matching tool_result, exports the whole live list", () => {
		const durable = [durableMessage([{ type: "text", text: "only text" }])];
		const live = [displayMessage({ createdAt: 10 }), displayMessage({ createdAt: 20 })];
		const tail = buildSessionExportLiveTail(durable, live);
		expect(tail?.messages.map((message) => message.createdAt)).toEqual([10, 20]);
	});

	it("returns null when nothing survives the start point", () => {
		const durable = [durableMessage([], 1000)];
		const live = [displayMessage({ createdAt: 10 })];
		expect(buildSessionExportLiveTail(durable, live)).toBeNull();
	});
});

describe("labelSegmentToolOrigins", () => {
	function createSegment(messages: ClineSdkPersistedMessage[]): ClineTaskExportSegment {
		return {
			header: buildSyntheticSessionHeader({
				sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
				kind: "task",
				providerId: null,
				modelId: null,
				cwd: null,
			}),
			artifactTaskId: "task-1",
			launchConfig: null,
			transcript: { status: "complete", reason: null },
			messages,
			liveTail: null,
			readError: null,
			toolOrigins: [],
		};
	}

	it("labels the first segment native and classifies the second against its predecessor", () => {
		const first = createSegment([
			durableMessage([{ type: "tool_use", id: "t1", name: "editor", input: {} }]),
			durableMessage([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
		]);
		const second = createSegment([
			durableMessage([
				{ type: "tool_use", id: "t1", name: "editor", input: {} }, // carried over by seeding/compaction
				{ type: "tool_use", id: "t2", name: "read_file", input: {} }, // fresh this run
			]),
		]);
		labelSegmentToolOrigins([first, second]);
		expect(first.toolOrigins).toEqual([
			{ messageIndex: 0, partIndex: 0, toolCallId: "t1", origin: "native" },
			{ messageIndex: 1, partIndex: 0, toolCallId: "t1", origin: "native" },
		]);
		expect(second.toolOrigins).toEqual([
			{ messageIndex: 0, partIndex: 0, toolCallId: "t1", origin: "seeded-or-compacted" },
			{ messageIndex: 0, partIndex: 1, toolCallId: "t2", origin: "native" },
		]);
	});

	it("ignores non-tool parts and records unknown for id-less tool parts", () => {
		const first = createSegment([durableMessage([{ type: "tool_use", id: "t1", name: "editor", input: {} }])]);
		const second = createSegment([
			durableMessage([
				{ type: "text", text: "hello" },
				{ type: "tool_result", tool_use_id: "t1", content: "ok" },
			]),
		]);
		labelSegmentToolOrigins([first, second]);
		expect(second.toolOrigins).toEqual([
			{ messageIndex: 0, partIndex: 1, toolCallId: "t1", origin: "seeded-or-compacted" },
		]);
	});
});

describe("collectDurableToolCallIds", () => {
	it("collects tool_use ids and tool_result references", () => {
		const ids = collectDurableToolCallIds([
			durableMessage([{ type: "tool_use", id: "a", name: "editor", input: {} }]),
			durableMessage([{ type: "tool_result", tool_use_id: "b", content: "ok" }]),
			durableMessage([{ type: "text", text: "no tools" }]),
		]);
		expect(ids).toEqual(new Set(["a", "b"]));
	});
});
