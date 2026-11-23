import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeHookMetadata } from "../../../src/commands/hooks";
import { buildOpenCodePluginSource } from "../../../src/terminal/opencode-plugin-source";

type BridgeHooks = {
	event?: (input: { event: unknown }) => Promise<void>;
	"tool.execute.before"?: (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;
	"tool.execute.after"?: (input: Record<string, unknown>) => Promise<void>;
	"permission.ask"?: (permission: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;
};

interface BridgeCall {
	event: string;
	sessionId: string | null;
	source: string | null;
	payload: Record<string, unknown>;
}

const originalTaskId = process.env.KANBAN_HOOK_TASK_ID;
const originalPinnedSessionId = process.env.KANBAN_OPENCODE_SESSION_ID;

let tempDirectories: string[] = [];
let tracePath = "";

/**
 * Loads the generated bridge the way OpenCode would: import the emitted file and
 * call the exported plugin with a client. Every Kanban call the bridge makes runs
 * through a recorder script, so the assertions read the real argv (including
 * `--session-id` and the base64 payload) instead of a reimplementation.
 */
async function setupBridge(
	options: { taskId?: string | null; pinnedSessionId?: string | null; client?: unknown } = {},
): Promise<BridgeHooks> {
	const directory = mkdtempSync(join(tmpdir(), "kanban-opencode-plugin-"));
	tempDirectories.push(directory);
	tracePath = join(directory, "trace.txt");
	const recorderPath = join(directory, "kanban-hook.sh");
	writeFileSync(
		recorderPath,
		`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(tracePath)}\nprintf '__END__\\n' >> ${JSON.stringify(tracePath)}\n`,
		{ mode: 0o755 },
	);

	if (options.taskId === null) {
		delete process.env.KANBAN_HOOK_TASK_ID;
	} else {
		process.env.KANBAN_HOOK_TASK_ID = options.taskId ?? "task-1";
	}
	if (options.pinnedSessionId) {
		process.env.KANBAN_OPENCODE_SESSION_ID = options.pinnedSessionId;
	} else {
		delete process.env.KANBAN_OPENCODE_SESSION_ID;
	}

	mkdirSync(join(directory, "plugin"), { recursive: true });
	const pluginPath = join(directory, "plugin", "index.js");
	writeFileSync(
		pluginPath,
		// The same argv the adapter generates, so a test can prove the flags that
		// select the metadata normalizer really reach the Kanban CLI.
		buildOpenCodePluginSource({
			reviewArgv: ["/bin/sh", recorderPath, "--event", "to_review", "--source", "opencode"],
			inProgressArgv: ["/bin/sh", recorderPath, "--event", "to_in_progress", "--source", "opencode"],
			activityArgv: ["/bin/sh", recorderPath, "--event", "activity", "--source", "opencode"],
		}),
		"utf8",
	);

	const loaded = (await import(pathToFileURL(pluginPath).href)) as unknown;
	if (!loaded || typeof loaded !== "object" || !("default" in loaded)) {
		throw new Error("expected the generated plugin to have a default export");
	}
	const bridge = (loaded as { default: (input: { client: unknown }) => Promise<BridgeHooks> }).default;
	return bridge({ client: options.client ?? null });
}

function readCalls(): BridgeCall[] {
	let raw = "";
	try {
		raw = readFileSync(tracePath, "utf8");
	} catch {
		return [];
	}
	const calls: BridgeCall[] = [];
	for (const block of raw.split("__END__\n")) {
		const lines = block.split("\n").filter((line) => line.length > 0);
		if (lines.length === 0) {
			continue;
		}
		const parsed: BridgeCall = { event: "", sessionId: null, source: null, payload: {} };
		for (let index = 0; index < lines.length; index += 1) {
			const flag = lines[index] ?? "";
			const value = lines[index + 1] ?? "";
			if (flag === "--event") {
				parsed.event = value;
				index += 1;
			} else if (flag === "--source") {
				parsed.source = value;
				index += 1;
			} else if (flag === "--session-id") {
				parsed.sessionId = value;
				index += 1;
			} else if (flag === "--metadata-base64") {
				parsed.payload = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;
				index += 1;
			}
		}
		calls.push(parsed);
	}
	return calls;
}

/** A client whose session list marks one session as another's child. */
function fakeClient(rows: Array<{ id: string; parentID?: string }>): unknown {
	return { session: { list: async () => ({ data: rows }) } };
}

async function emit(hooks: BridgeHooks, event: Record<string, unknown>): Promise<void> {
	await hooks.event?.({ event });
}

afterEach(() => {
	if (originalTaskId === undefined) {
		delete process.env.KANBAN_HOOK_TASK_ID;
	} else {
		process.env.KANBAN_HOOK_TASK_ID = originalTaskId;
	}
	if (originalPinnedSessionId === undefined) {
		delete process.env.KANBAN_OPENCODE_SESSION_ID;
	} else {
		process.env.KANBAN_OPENCODE_SESSION_ID = originalPinnedSessionId;
	}
	for (const directory of tempDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	tempDirectories = [];
});

describe("generated OpenCode bridge (AA-O1)", () => {
	it("stays inert without a task id", async () => {
		const hooks = await setupBridge({ taskId: null });
		// OpenCode loads plugins globally, so the generated file must not act for
		// a session Kanban does not own.
		expect(Object.keys(hooks)).toEqual([]);
		expect(readCalls()).toEqual([]);
	});

	it("reports one review per turn and starts a new turn afterwards", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });
		// The pinned release emits idle twice per turn, and a duplicate must not
		// reopen a review the human has not looked at.
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		expect(readCalls().map((call) => [call.event, call.sessionId])).toEqual([
			["to_in_progress", "ses_root01"],
			["to_review", "ses_root01"],
			["to_in_progress", "ses_root01"],
			["to_review", "ses_root01"],
		]);
	});

	it("keeps the streamed assistant text as the final message", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, {
			type: "message.updated",
			properties: { info: { id: "msg_1", role: "assistant", sessionID: "ses_root01" } },
		});
		// Text arrives as deltas, and a `part` with the full text may repeat them.
		await emit(hooks, {
			type: "message.part.updated",
			properties: {
				part: { type: "text", messageID: "msg_1", sessionID: "ses_root01", text: "" },
				delta: "Done ",
			},
		});
		await emit(hooks, {
			type: "message.part.updated",
			properties: {
				part: { type: "text", messageID: "msg_1", sessionID: "ses_root01", text: "" },
				delta: "✓",
			},
		});
		await emit(hooks, {
			type: "message.part.updated",
			properties: {
				part: { type: "text", messageID: "msg_2", sessionID: "ses_root01", text: "user note" },
			},
		});
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		const reviews = readCalls().filter((call) => call.event === "to_review");
		expect(reviews).toHaveLength(1);
		// Unicode survives, and the user's own message is never the summary.
		expect(reviews[0]?.payload.final_message).toBe("Done ✓");
		expect(reviews[0]?.payload.source).toBe("opencode");
	});

	it("treats a permission request as attention, not completion", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await hooks["permission.ask"]?.(
			{ sessionID: "ses_root01", permission: "bash", pattern: "rm -rf *" },
			{ status: "ask" },
		);
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		let calls = readCalls();
		expect(calls.map((call) => call.event)).toEqual(["to_in_progress", "to_review"]);
		expect(calls[1]?.payload.notification_type).toBe("permission.asked");
		expect(calls[1]?.payload.hook_event_name).toBe("PermissionRequest");
		expect(String(calls[1]?.payload.activity_text)).toContain("waiting for approval");

		// The card resumes after the human approves, and only a later idle is a
		// finished turn.
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });
		calls = readCalls();
		expect(calls.slice(2).map((call) => [call.event, call.payload.notification_type])).toEqual([
			["to_in_progress", undefined],
			["to_review", undefined],
		]);
	});

	it("ignores a permission that is already answered", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await hooks["permission.ask"]?.({ sessionID: "ses_root01", permission: "bash" }, { status: "deny" });
		expect(readCalls().map((call) => call.event)).toEqual(["to_in_progress"]);
	});

	it("attributes the card to the root session, never a child", async () => {
		const hooks = await setupBridge({
			client: fakeClient([{ id: "ses_root01" }, { id: "ses_child1", parentID: "ses_root01" }, { id: "ses_orphan" }]),
		});
		// A sub-agent finishing its part must not look like the card is done.
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_child1" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_child1" } });
		expect(readCalls()).toEqual([]);

		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_orphan" } });
		expect(readCalls().map((call) => [call.event, call.sessionId])).toEqual([
			["to_in_progress", "ses_root01"],
			["to_review", "ses_root01"],
		]);
	});

	it("pins the session Kanban already recorded", async () => {
		const hooks = await setupBridge({ pinnedSessionId: "ses_root01" });
		// Without the pin the first session seen would become the root, so another
		// task's activity could park or finish this card.
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_other01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_other01" } });
		expect(readCalls()).toEqual([]);

		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });
		expect(readCalls().map((call) => call.sessionId)).toEqual(["ses_root01", "ses_root01"]);
	});
	it("goes silent when pinned to a session that is no longer running", async () => {
		// This is why a fresh launch must not pin a recorded id: OpenCode started a
		// new conversation, so a bridge pinned to the previous id ignores every event
		// from it and the card would never leave running.
		const hooks = await setupBridge({ pinnedSessionId: "ses_old00000" });
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_new00001" } });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_new00001" } });
		expect(readCalls()).toEqual([]);
	});

	it("reports a failed turn without marking the task complete", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, {
			type: "session.error",
			properties: { sessionID: "ses_root01", error: { data: { message: "429 rate limited" } } },
		});
		await emit(hooks, {
			type: "session.error",
			properties: { sessionID: "ses_root01", error: { data: { message: "429 rate limited" } } },
		});
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		const calls = readCalls();
		expect(calls.map((call) => call.event)).toEqual(["to_in_progress", "to_review"]);
		expect(calls[1]?.payload.notification_type).toBe("error");
		expect(calls[1]?.payload.activity_text).toBe("429 rate limited");
	});

	it("records tool activity with the tool name and input summary", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await hooks["tool.execute.before"]?.(
			{ sessionID: "ses_root01", tool: "bash", callID: "call_1" },
			{ args: { command: "ls -la" } },
		);
		await hooks["tool.execute.after"]?.({ sessionID: "ses_root01", tool: "bash", callID: "call_1" });

		const activity = readCalls().filter((call) => call.event === "activity");
		expect(activity.map((call) => call.payload.hook_event_name)).toEqual(["BeforeTool", "AfterTool"]);
		expect(activity[0]?.payload.tool_name).toBe("bash");
		expect(activity[0]?.payload.tool_input_summary).toBe("command=ls -la");
		// The busy turn was already reported, so the tool does not reopen it.
		expect(readCalls().filter((call) => call.event === "to_in_progress")).toHaveLength(1);
	});

	it("resumes the turn when a permission is answered inside the tool", async () => {
		const hooks = await setupBridge();
		// This release checks the permission inside the running tool, so this is the
		// real order once the human approves: no second `before` and no
		// `session.busy` between the approval and the tool finishing. If the parked
		// turn is not resumed here, the card stays in attention and the turn's final
		// idle is dropped as a duplicate.
		await hooks["tool.execute.before"]?.(
			{ sessionID: "ses_root01", tool: "bash", callID: "call_1" },
			{ args: { command: "npm test" } },
		);
		await hooks["permission.ask"]?.(
			{ sessionID: "ses_root01", permission: "bash", pattern: "npm test" },
			{ status: "ask" },
		);
		await hooks["tool.execute.after"]?.({ sessionID: "ses_root01", tool: "bash", callID: "call_1" });
		await emit(hooks, {
			type: "message.updated",
			properties: { info: { id: "msg_9", role: "assistant", sessionID: "ses_root01" } },
		});
		await emit(hooks, {
			type: "message.part.updated",
			properties: {
				part: { type: "text", messageID: "msg_9", sessionID: "ses_root01", text: "All 12 tests pass." },
			},
		});
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		const calls = readCalls();
		expect(calls.map((call) => [call.event, call.payload.hook_event_name])).toEqual([
			["to_in_progress", "BeforeTool"],
			["activity", "BeforeTool"],
			["to_review", "PermissionRequest"],
			["to_in_progress", "AfterTool"],
			["activity", "AfterTool"],
			["to_review", "session.idle"],
		]);
		const completion = calls[calls.length - 1];
		expect(completion?.event).toBe("to_review");
		// The finished turn is an ordinary completion, not a second approval.
		expect(completion?.payload.notification_type).toBeUndefined();
		expect(completion?.payload.final_message).toBe("All 12 tests pass.");
	});

	it("lets a turn that errored finish once work continues", async () => {
		const hooks = await setupBridge();
		await emit(hooks, { type: "session.busy", properties: { sessionID: "ses_root01" } });
		await emit(hooks, {
			type: "session.error",
			properties: { sessionID: "ses_root01", error: { data: { message: "429 rate limited" } } },
		});
		// The human types again, a tool finishes, and the turn reaches idle: the
		// error card has to be able to close, not sit parked forever.
		await hooks["tool.execute.after"]?.({ sessionID: "ses_root01", tool: "bash", callID: "call_9" });
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		expect(readCalls().map((call) => [call.event, call.payload.notification_type])).toEqual([
			["to_in_progress", undefined],
			["to_review", "error"],
			["to_in_progress", undefined],
			["activity", undefined],
			["to_review", undefined],
		]);
	});

	it("reports the text the card shows through the real ingest parsing", async () => {
		const hooks = await setupBridge();
		await hooks["tool.execute.before"]?.(
			{ sessionID: "ses_root01", tool: "edit", callID: "call_1" },
			{ args: { filePath: "src/a.ts" } },
		);
		await emit(hooks, {
			type: "message.updated",
			properties: { info: { id: "msg_5", role: "assistant", sessionID: "ses_root01" } },
		});
		await emit(hooks, {
			type: "message.part.updated",
			properties: {
				part: { type: "text", messageID: "msg_5", sessionID: "ses_root01", text: "Rewrote the ingest path." },
			},
		});
		await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_root01" } });

		const calls = readCalls();
		const activity = calls.find((call) => call.event === "activity" && call.payload.hook_event_name === "BeforeTool");
		const review = calls.find((call) => call.event === "to_review");
		if (!activity || !review) {
			throw new Error("expected the bridge to report both the tool and the review");
		}
		// The argv the adapter generates names its source, and the OpenCode
		// normalizer reads the bridge's own payload keys. Running both through the
		// real ingest parsing is what proves the text reaches the card; asserting on
		// the argv alone is how this stayed invisible.
		expect(activity.source).toBe("opencode");
		expect(review.source).toBe("opencode");
		const activityMetadata = normalizeHookMetadata("activity", activity.payload, { source: activity.source });
		expect(activityMetadata?.source).toBe("opencode");
		expect(activityMetadata?.toolName).toBe("edit");
		expect(activityMetadata?.toolInputSummary).toBe("filePath=src/a.ts");
		expect(activityMetadata?.activityText).toContain("edit");
		const reviewMetadata = normalizeHookMetadata("to_review", review.payload, { source: review.source });
		expect(reviewMetadata?.source).toBe("opencode");
		expect(reviewMetadata?.finalMessage).toBe("Rewrote the ingest path.");
		expect(reviewMetadata?.activityText).toBe("OpenCode finished the turn");
	});
});
