import { describe, expect, it, vi } from "vitest";
import { ClineTurnScheduler } from "../../../src/cline-sdk/cline-turn-scheduler";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { PiInitialTurnCapacityGate } from "../../../src/terminal/pi-initial-turn-capacity";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

function summary(taskId: string, change: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId, state: "running", agentId: "pi", workspacePath: "/tmp/task",
		pid: 100, startedAt: Date.now(), updatedAt: Date.now(),
		lastOutputAt: null, reviewReason: null, exitCode: null, lastHookAt: null,
		latestHookActivity: null, ...change,
	};
}

function fakeManager() {
	const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
	const manager = {
		onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	} as unknown as TerminalSessionManager;
	return {
		manager,
		emit: (value: RuntimeTaskSessionSummary) => {
			for (const listener of listeners) listener(value);
		},
		listenerCount: () => listeners.size,
	};
}

async function tick() {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const target = { providerId: "pi", modelId: "qwen", baseUrl: "http://localhost:8080/v1" };

describe("PiInitialTurnCapacityGate", () => {
	it("queues the next initial Pi turn until the prior task settles, not until its PTY exits", async () => {
		const scheduler = new ClineTurnScheduler(async () => 1);
		const gate = new PiInitialTurnCapacityGate(scheduler);
		const fake = fakeManager();
		const firstLaunch = vi.fn(async () => summary("a"));
		const secondLaunch = vi.fn(async () => summary("b"));
		const first = gate.start("workspace", "a", fake.manager, target, firstLaunch);
		expect((await first).taskId).toBe("a");
		const second = gate.start("workspace", "b", fake.manager, target, secondLaunch);
		await tick();
		expect(secondLaunch).not.toHaveBeenCalled();
		fake.emit(summary("a", {
			state: "awaiting_review", reviewReason: "hook", lastHookAt: Date.now(),
			latestHookActivity: {
				source: "pi", hookEventName: "agent_settled",
				activityText: "done", toolName: null, toolInputSummary: null,
				finalMessage: null, notificationType: null,
			},
		}));
		expect((await second).taskId).toBe("b");
		expect(secondLaunch).toHaveBeenCalledOnce();
		fake.emit(summary("b", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(fake.listenerCount()).toBe(0);
	});

	it("allows user-configured oversubscription while Pi spends time sleeping", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 3));
		const fake = fakeManager();
		const launches = ["a", "b", "c"].map((taskId) => vi.fn(async () => summary(taskId)));
		const started = launches.map((launch, index) =>
			gate.start("workspace", String(index), fake.manager, target, launch));
		await Promise.all(started);
		for (const launch of launches) expect(launch).toHaveBeenCalledOnce();
		for (let index = 0; index < launches.length; index += 1) {
			fake.emit(summary(String(index), { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		}
		await tick();
		expect(fake.listenerCount()).toBe(0);
	});

	it("cancels a waiting admission before Pi is launched", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		await gate.start("workspace", "a", fake.manager, target, async () => summary("a"));
		const launch = vi.fn(async () => summary("b"));
		const waiting = gate.start("workspace", "b", fake.manager, target, launch);
		await tick();
		expect(gate.cancel("workspace", "b")).toBe(true);
		await expect(waiting).rejects.toThrow("Cline turn canceled");
		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(launch).not.toHaveBeenCalled();
	});

	it("deduplicates concurrent requests to start the same task", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		const launch = vi.fn(async () => summary("a"));
		const [first, second] = await Promise.all([
			gate.start("workspace", "a", fake.manager, target, launch),
			gate.start("workspace", "a", fake.manager, target, launch),
		]);
		expect(first).toEqual(second);
		expect(launch).toHaveBeenCalledOnce();
		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
	});
});
