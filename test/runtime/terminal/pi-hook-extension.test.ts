// AA-P1: the generated Pi extension is the only thing that turns a Pi run into
// Kanban card movement, so it is exercised as a real module: the source is
// written to disk, imported, and its handlers are called with Pi-shaped events.
// The notifications are then read back from a recorder process, which also
// proves the base64 payload survives the hook CLI.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildPiHookExtensionSource } from "../../../src/terminal/pi-hook-extension";

const RECORDER_SOURCE = [
	'import { appendFileSync } from "node:fs";',
	'appendFileSync(process.env.KANBAN_PI_TEST_OUT, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");',
	"",
].join("\n");

const originalTaskId = process.env.KANBAN_HOOK_TASK_ID;

interface NotifyRecord {
	/** Kanban hook event the extension asked for. */
	event: string;
	/** CLI flags as emitted, including the fixed `--source pi`. */
	flags: Record<string, string>;
	/** Decoded `--metadata-base64` payload, when one was sent. */
	payload: Record<string, unknown> | null;
}

interface PiExtensionHarness {
	/** Pi event names the extension subscribed to. */
	registered(): string[];
	/** Calls one registered handler the way Pi would. */
	invoke(eventName: string, event: unknown, ctx: unknown): Promise<unknown>;
	/** Waits until at least `count` notifications landed and returns them. */
	notifications(count: number): Promise<NotifyRecord[]>;
	/** Notifications recorded so far, without waiting. */
	recorded(): Promise<NotifyRecord[]>;
}

function parseRecord(line: string): NotifyRecord {
	const args: string[] = JSON.parse(line);
	const flags: Record<string, string> = {};
	let payload: Record<string, unknown> | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--metadata-base64") {
			const encoded = args[index + 1] ?? "";
			payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
			index += 1;
			continue;
		}
		if (arg.startsWith("--")) {
			flags[arg] = args[index + 1] ?? "";
			index += 1;
		}
	}
	return { event: flags["--event"] ?? "", flags, payload };
}

/**
 * Each notification is its own detached process, so the order they land in is
 * not part of the contract. Every assertion finds a notification by the Pi
 * event it reports instead of by position.
 */
function findByHookEvent(records: NotifyRecord[], hookEventName: string): NotifyRecord {
	const record = records.find((candidate) => candidate.flags["--hook-event-name"] === hookEventName);
	if (!record) {
		throw new Error(`expected a notification for ${hookEventName}`);
	}
	return record;
}

function makeCtx(sessionId: string | null, options: { hasPendingMessages?: boolean } = {}): unknown {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => (sessionId === null ? null : `/sessions/${sessionId}.jsonl`),
		},
		hasPendingMessages: () => options.hasPendingMessages === true,
	};
}

function assistantMessage(options: { text?: string; stopReason?: string; error?: string }): unknown {
	return {
		role: "assistant",
		stopReason: options.stopReason ?? "stop",
		...(options.error === undefined ? {} : { error: options.error }),
		content: [{ type: "text", text: options.text ?? "" }],
	};
}

async function createPiExtensionHarness(input: {
	sessionId: string;
	/** False simulates a nested Pi with no Kanban hook owner. */
	hookOwner?: boolean;
}): Promise<PiExtensionHarness> {
	const hookOwner = input.hookOwner ?? true;
	const directory = await mkdtemp(join(tmpdir(), "kanban-pi-extension-"));
	const recorderPath = join(directory, "recorder.mjs");
	const extensionPath = join(directory, "kanban-pi-hook.mjs");
	const outputPath = join(directory, "notifications.jsonl");
	await writeFile(outputPath, "", "utf8");
	await writeFile(recorderPath, RECORDER_SOURCE, "utf8");
	process.env.KANBAN_PI_TEST_OUT = outputPath;
	if (hookOwner) {
		process.env.KANBAN_HOOK_TASK_ID = "task-1";
	} else {
		delete process.env.KANBAN_HOOK_TASK_ID;
	}
	await writeFile(
		extensionPath,
		buildPiHookExtensionSource({
			sessionId: input.sessionId,
			agentVersion: "1.5.2",
			notifyCommand: [process.execPath, recorderPath],
		}),
		"utf8",
	);

	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const loaded = (await import(pathToFileURL(extensionPath).href)) as {
		default?: (pi: unknown) => void;
	};
	expect(typeof loaded.default).toBe("function");
	loaded.default?.({
		on: (eventName: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(eventName, handler);
		},
	});

	const read = async (): Promise<NotifyRecord[]> => {
		const text = await readFile(outputPath, "utf8");
		return text
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map(parseRecord);
	};

	return {
		registered: () => [...handlers.keys()],
		invoke: async (eventName, event, ctx) => {
			const handler = handlers.get(eventName);
			if (!handler) {
				throw new Error(`expected the extension to handle ${eventName}`);
			}
			return await handler(event, ctx);
		},
		notifications: async (count) => {
			// Every notification is its own detached process, so give them room
			// to land instead of asserting after a fixed sleep.
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const records = await read();
				if (records.length >= count) {
					return records;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`expected at least ${count} Kanban notifications`);
		},
		recorded: read,
	};
}

afterEach(() => {
	if (originalTaskId === undefined) {
		delete process.env.KANBAN_HOOK_TASK_ID;
	} else {
		process.env.KANBAN_HOOK_TASK_ID = originalTaskId;
	}
	delete process.env.KANBAN_PI_TEST_OUT;
});

describe("Kanban Pi hook extension", () => {
	it("registers nothing when the run has no Kanban hook owner", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1", hookOwner: false });
		expect(harness.registered()).toEqual([]);
	});

	it("subscribes to the Pi events the card lifecycle needs", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		expect(harness.registered()).toEqual(
			expect.arrayContaining([
				"session_start",
				"agent_start",
				"message_end",
				"tool_execution_start",
				"tool_execution_end",
				"model_select",
				"ui_prompt_start",
				"ui_prompt_end",
				"agent_settled",
				"session_before_switch",
				"session_before_fork",
			]),
		);
	});

	it("moves the card to review only once the turn has settled cleanly", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		await harness.invoke("message_end", { message: assistantMessage({ text: "Fixed the flaky test." }) }, ctx);
		await harness.invoke("agent_settled", { aborted: false }, ctx);

		const records = await harness.notifications(2);
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.flags["--source"] === "pi")).toBe(true);

		const started = findByHookEvent(records, "agent_start");
		expect(started.event).toBe("to_in_progress");

		const settled = findByHookEvent(records, "agent_settled");
		expect(settled.event).toBe("to_review");
		expect(settled.flags["--final-message"]).toBe("Fixed the flaky test.");
		expect(settled.payload).toMatchObject({
			source: "pi",
			hook_event_name: "agent_settled",
			pi_session_id: "kanban-task-1",
			pi_agent_version: "1.5.2",
			final_message: "Fixed the flaky test.",
		});
	});
	it("moves a recovered tool failure on to review instead of stalling the card", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		// A red test run is routine, so it must not decide how the turn ends.
		await harness.invoke(
			"tool_execution_end",
			{ toolName: "bash", args: { command: "npm test" }, result: { output: "1 failed" }, isError: true },
			ctx,
		);
		await harness.invoke("message_end", { message: assistantMessage({ text: "Green again after the fix." }) }, ctx);
		await harness.invoke("agent_settled", { aborted: false }, ctx);

		const records = await harness.notifications(3);
		expect(records).toHaveLength(3);
		const settled = findByHookEvent(records, "agent_settled");
		expect(settled.event).toBe("to_review");
		expect(settled.flags["--final-message"]).toBe("Green again after the fix.");
		expect(settled.payload).not.toHaveProperty("pi_error");
		// The failure stays visible as metadata without becoming the turn outcome.
		expect(findByHookEvent(records, "tool_execution_end").flags["--notification-type"]).toBe("error");
	});

	it("retains publication arguments from the start event when the result has no args", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");
		const command = `gh api -X POST repos/octo/repo/pulls/42/comments -F in_reply_to=12 -f body="${"x".repeat(2500)}"`;
		const output = JSON.stringify({ id: 77, url: "https://api.github.com/repos/octo/repo/pulls/comments/77" });
		await harness.invoke("tool_execution_start", { toolName: "bash", toolCallId: "call-42", args: { command } }, ctx);
		const started = findByHookEvent(await harness.recorded(), "tool_execution_start");
		expect(started.payload).toMatchObject({ tool_call_id: "call-42", tool_input: { command } });
		await harness.invoke(
			"tool_execution_end",
			{ toolName: "bash", toolCallId: "call-42", result: { content: [{ type: "text", text: output }] }, isError: false },
			ctx,
		);
		const finished = findByHookEvent(await harness.recorded(), "tool_execution_end");
		expect(finished.payload).toMatchObject({ tool_call_id: "call-42", tool_input: { command }, tool_response: { output } });
	});

	it("still reports a turn that stops on a failed tool call as an error", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		await harness.invoke(
			"tool_execution_end",
			{ toolName: "bash", args: { command: "npm run build" }, result: { output: "exit 2" }, isError: true },
			ctx,
		);
		// Nothing recovered the run, so the failure is still how it ended.
		await harness.invoke("agent_settled", { aborted: false }, ctx);

		const records = await harness.notifications(3);
		expect(records).toHaveLength(3);
		const settled = findByHookEvent(records, "agent_settled");
		expect(settled.event).toBe("activity");
		expect(settled.flags["--notification-type"]).toBe("error");
		expect(settled.payload).toMatchObject({ pi_error: expect.stringContaining("bash") });
		expect(records.some((record) => record.event === "to_review")).toBe(false);
	});

	it("brings the card back to In Progress when the extension dialog closes", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		await harness.invoke("ui_prompt_start", { reason: "custom", kind: "select", title: "Pick a migration" }, ctx);
		await harness.invoke("ui_prompt_end", { reason: "custom" }, ctx);

		const records = await harness.notifications(3);
		expect(records).toHaveLength(3);
		expect(findByHookEvent(records, "ui_prompt_start").event).toBe("to_review");
		const resumed = findByHookEvent(records, "ui_prompt_end");
		expect(resumed.event).toBe("to_in_progress");
		expect(resumed.flags["--source"]).toBe("pi");

		// The run continues, so the eventual settle still owns the review move.
		await harness.invoke(
			"message_end",
			{ message: assistantMessage({ text: "Applied the second migration." }) },
			ctx,
		);
		await harness.invoke("agent_settled", { aborted: false }, ctx);
		const all = await harness.notifications(4);
		expect(all).toHaveLength(4);
		expect(findByHookEvent(all, "agent_settled").event).toBe("to_review");
	});

	it("never moves the card for a dialog this run never opened", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		await harness.invoke("ui_prompt_end", { reason: "custom" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await harness.recorded()).toHaveLength(1);

		// A close after the turn settled belongs to no turn either.
		await harness.invoke("ui_prompt_start", { reason: "custom", kind: "select", title: "Pick one" }, ctx);
		await harness.invoke("agent_settled", { aborted: false }, ctx);
		await harness.invoke("ui_prompt_end", { reason: "custom" }, ctx);
		const records = await harness.notifications(3);
		expect(records).toHaveLength(3);
		expect(records.some((record) => record.flags["--hook-event-name"] === "ui_prompt_end")).toBe(false);
	});

	it("keeps a failed turn as activity instead of pretending completion", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		await harness.invoke(
			"tool_execution_end",
			{ toolName: "bash", args: { command: "npm test" }, result: { output: "1 failed" }, isError: true },
			ctx,
		);
		await harness.invoke(
			"message_end",
			{ message: assistantMessage({ text: "Partial work.", stopReason: "error", error: "upstream 502" }) },
			ctx,
		);
		await harness.invoke("agent_settled", { aborted: false }, ctx);

		const records = await harness.notifications(3);
		expect(records).toHaveLength(3);
		expect(records.map((record) => record.event).sort()).toEqual(["activity", "activity", "to_in_progress"]);

		const failedTool = findByHookEvent(records, "tool_execution_end");
		expect(failedTool.flags["--tool-name"]).toBe("bash");
		expect(failedTool.payload).toMatchObject({ tool_name: "bash", tool_input: { command: "npm test" } });

		const settled = findByHookEvent(records, "agent_settled");
		expect(settled.flags["--notification-type"]).toBe("error");
		expect(settled.flags["--final-message"]).toBeUndefined();
		expect(settled.payload).toMatchObject({ pi_error: expect.stringContaining("upstream 502") });
		// Nothing here may look like a finished turn.
		expect(records.some((record) => record.event === "to_review")).toBe(false);
	});

	it("does not call a stopped or queued turn finished", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await harness.invoke("agent_start", {}, ctx);
		await harness.invoke("agent_settled", { aborted: true }, ctx);
		const records = await harness.notifications(2);
		expect(records).toHaveLength(2);
		const stopped = findByHookEvent(records, "agent_settled");
		expect(stopped.event).toBe("activity");
		expect(stopped.flags["--notification-type"]).toBe("aborted");

		// A queued continuation means the run is not over, so no completion.
		await harness.invoke("agent_settled", { aborted: false }, makeCtx("kanban-task-1", { hasPendingMessages: true }));
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await harness.recorded()).toHaveLength(2);
	});

	it("refuses to follow a session switch or fork", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });
		const ctx = makeCtx("kanban-task-1");

		await expect(harness.invoke("session_before_switch", {}, ctx)).resolves.toEqual({ cancel: true });
		await expect(harness.invoke("session_before_fork", {}, ctx)).resolves.toEqual({ cancel: true });
		const pinned = await harness.notifications(2);
		expect(pinned).toHaveLength(2);
		// Both notices say the same thing, so only the events distinguish them.
		expect(findByHookEvent(pinned, "session_before_switch").flags["--notification-type"]).toBe("session_pinned");
		expect(findByHookEvent(pinned, "session_before_fork").flags["--notification-type"]).toBe("session_pinned");
	});

	it("drops events from a session Kanban does not own", async () => {
		const harness = await createPiExtensionHarness({ sessionId: "kanban-task-1" });

		await harness.invoke("agent_start", {}, makeCtx("someone-elses-session"));
		await harness.invoke("agent_settled", { aborted: false }, makeCtx("someone-elses-session"));
		const records = await harness.notifications(1);
		// Only the one-shot notice that this card stopped following the session.
		expect(records.map((record) => record.flags["--hook-event-name"])).toEqual(["session_changed"]);
	});
});
