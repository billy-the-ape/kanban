import { describe, expect, it, vi } from "vitest";
import { ClineTurnScheduler } from "../../../src/cline-sdk/cline-turn-scheduler";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { PiStartRequest } from "../../../src/terminal/pi-initial-turn-capacity";
import { PiInitialTurnCapacityGate } from "../../../src/terminal/pi-initial-turn-capacity";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const target = { providerId: "pi", modelId: "qwen", baseUrl: "http://localhost:8080/v1" };

type Admission = Awaited<ReturnType<PiInitialTurnCapacityGate["request"]>>;

function summary(taskId: string, change: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "pi",
		workspacePath: "/tmp/task",
		pid: 100,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...change,
	};
}

function fakeManager() {
	const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
	const waits: Array<{ taskId: string; queuePosition: number | null }> = [];
	const settles: Array<{ taskId: string; error: string | null }> = [];
	const stops: string[] = [];
	const manager = {
		onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		recordModelCapacityWait: (input: { taskId: string; queuePosition?: number | null }) => {
			waits.push({ taskId: input.taskId, queuePosition: input.queuePosition ?? null });
			return summary(input.taskId, { state: "idle", pid: null, warningMessage: "Waiting for a free model slot" });
		},
		settleModelCapacityWait: (taskId: string, error: string | null) => {
			settles.push({ taskId, error });
			return summary(taskId, { state: error === null ? "idle" : "failed" });
		},
		stopTaskSession: (taskId: string) => {
			stops.push(taskId);
			return summary(taskId, { state: "idle", pid: null });
		},
	} as unknown as TerminalSessionManager;
	return {
		manager,
		emit: (value: RuntimeTaskSessionSummary) => {
			for (const listener of listeners) listener(value);
		},
		listenerCount: () => listeners.size,
		waits,
		settles,
		stops,
	};
}

function startInput(
	fake: ReturnType<typeof fakeManager>,
	taskId: string,
	launch: () => Promise<RuntimeTaskSessionSummary>,
	isCurrent?: () => boolean,
): PiStartRequest {
	return {
		workspaceId: "workspace",
		taskId,
		workspacePath: "/tmp/task",
		manager: fake.manager,
		target,
		launch,
		...(isCurrent ? { isCurrent } : {}),
	};
}

/** Fails loudly instead of asserting through a nullable union. */
function expectLaunched(admission: Admission): RuntimeTaskSessionSummary {
	if (admission.status !== "launched") {
		throw new Error(`Expected a launched start, received ${admission.status}.`);
	}
	return admission.summary;
}

function expectQueued(admission: Admission): number | null {
	if (admission.status !== "queued") {
		throw new Error(`Expected a queued start, received ${admission.status}.`);
	}
	return admission.queuePosition;
}

function settled(taskId: string): RuntimeTaskSessionSummary {
	return summary(taskId, {
		state: "awaiting_review",
		reviewReason: "hook",
		lastHookAt: Date.now(),
		latestHookActivity: {
			source: "pi",
			hookEventName: "agent_settled",
			activityText: "done",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			notificationType: null,
		},
	});
}

async function tick(): Promise<void> {
	for (let i = 0; i < 24; i += 1) await Promise.resolve();
}

describe("PiInitialTurnCapacityGate", () => {
	it("launches immediately when a slot is free and holds it until the task settles, not until its PTY exits", async () => {
		const scheduler = new ClineTurnScheduler(async () => 1);
		const gate = new PiInitialTurnCapacityGate(scheduler);
		const fake = fakeManager();
		const firstLaunch = vi.fn(async () => summary("a"));
		const launched = await gate.request(startInput(fake, "a", firstLaunch));
		expect(launched.status).toBe("launched");
		expect(expectLaunched(launched).taskId).toBe("a");
		expect(fake.waits).toEqual([]);

		const secondLaunch = vi.fn(async () => summary("b"));
		const queued = await gate.request(startInput(fake, "b", secondLaunch));
		// The request answered without waiting for the slot: dispatch keeps its lock.
		expect(expectQueued(queued)).toBe(1);
		// The waiting record carries the queue position, so the card can say
		// where it is waiting instead of only that it is idle.
		expect(fake.waits).toEqual([{ taskId: "b", queuePosition: 1 }]);
		expect(secondLaunch).not.toHaveBeenCalled();

		fake.emit(settled("a"));
		await tick();
		expect(secondLaunch).toHaveBeenCalledOnce();

		fake.emit(summary("b", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(fake.listenerCount()).toBe(0);
	});

	it("admits as many initial turns as the configured capacity allows", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 3));
		const fake = fakeManager();
		const launches = ["a", "b", "c"].map((taskId) => vi.fn(async () => summary(taskId)));
		const started = launches.map((launch, index) => gate.request(startInput(fake, String(index), launch)));
		const admissions = await Promise.all(started);
		for (const admission of admissions) expect(admission.status).toBe("launched");
		for (const launch of launches) expect(launch).toHaveBeenCalledOnce();
		for (let index = 0; index < launches.length; index += 1) {
			fake.emit(summary(String(index), { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		}
		await tick();
		expect(fake.listenerCount()).toBe(0);
	});

	it("settles the waiting record as canceled when Stop cancels a queued start", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		await gate.request(startInput(fake, "a", async () => summary("a")));
		const launch = vi.fn(async () => summary("b"));
		const queued = await gate.request(startInput(fake, "b", launch));
		expect(queued.status).toBe("queued");

		expect(gate.cancel("workspace", "b")).toBe(true);
		await tick();
		expect(launch).not.toHaveBeenCalled();
		expect(fake.settles).toEqual([{ taskId: "b", error: null }]);

		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(launch).not.toHaveBeenCalled();
	});

	it("reports a queued launch failure on the waiting record instead of losing it", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		await gate.request(startInput(fake, "a", async () => summary("a")));
		const failure = new Error('Failed to launch "pi". Command not found.');
		const queued = await gate.request(
			startInput(fake, "b", async () => {
				throw failure;
			}),
		);
		expect(queued.status).toBe("queued");
		expect(fake.settles).toEqual([]);

		// The queued CLI only spawns once the first task frees its slot.
		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(fake.settles).toEqual([{ taskId: "b", error: failure.message }]);
	});

	it("stops a process spawned when Stop landed mid-spawn", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 2));
		const fake = fakeManager();
		let resolveLaunch!: (value: RuntimeTaskSessionSummary) => void;
		const request = gate.request(
			startInput(
				fake,
				"a",
				() =>
					new Promise<RuntimeTaskSessionSummary>((resolve) => {
						resolveLaunch = resolve;
					}),
			),
		);
		await tick();
		expect(gate.cancel("workspace", "a")).toBe(true);
		resolveLaunch(summary("a"));
		const launched = await request;
		expect(launched.status).toBe("launched");
		expect(fake.stops).toEqual(["a"]);
		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
	});

	it("deduplicates concurrent requests to start the same task", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		const launch = vi.fn(async () => summary("a"));
		const [first, second] = await Promise.all([
			gate.request(startInput(fake, "a", launch)),
			gate.request(startInput(fake, "a", launch)),
		]);
		expect(first).toEqual(second);
		expect(launch).toHaveBeenCalledOnce();
		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
	});

	it("never launches a queued CLI whose card moved on", async () => {
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		await gate.request(startInput(fake, "a", async () => summary("a")));
		const launch = vi.fn(async () => summary("b"));
		// The card was returned to Backlog (or relaunched) while this start queued.
		const queued = await gate.request(startInput(fake, "b", launch, () => false));
		expect(queued.status).toBe("queued");

		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(launch).not.toHaveBeenCalled();
		// A card that moved on is idle again, not a failure the human must explain.
		expect(fake.settles).toEqual([{ taskId: "b", error: null }]);
	});

	it("answers for its own pending starts so dispatch can count the worker slot", async () => {
		// Task dispatch must not read the wait off the card's summary — a record
		// left behind by a restart would hold a worker slot forever — so the queue
		// itself says which cards it still owes a CLI to.
		const gate = new PiInitialTurnCapacityGate(new ClineTurnScheduler(async () => 1));
		const fake = fakeManager();
		expect(gate.hasPending("workspace", "a")).toBe(false);
		await gate.request(startInput(fake, "a", async () => summary("a")));
		expect(gate.hasPending("workspace", "a")).toBe(true);
		const launch = vi.fn(async () => summary("b"));
		expect((await gate.request(startInput(fake, "b", launch))).status).toBe("queued");
		expect(gate.hasPending("workspace", "b")).toBe(true);
		gate.cancel("workspace", "b");
		await tick();
		// A canceled wait frees the card's dispatch slot for the next pass.
		expect(gate.hasPending("workspace", "b")).toBe(false);
		fake.emit(summary("a", { pid: null, state: "awaiting_review", reviewReason: "exit" }));
		await tick();
		expect(gate.hasPending("workspace", "a")).toBe(false);
	});
});
