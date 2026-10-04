import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClineTurnCapacityResolver,
	ClineTurnScheduler,
	type ClineTurnTarget,
	clineTurnTargetKey,
} from "../../../src/cline-sdk/cline-turn-scheduler";

const target: ClineTurnTarget = {
	providerId: "openai-compatible",
	modelId: "qwen3.8-27b",
	baseUrl: "http://127.0.0.1:8080/v1/",
	apiKey: "test-key",
};

function gate() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("model capacity discovery", () => {
	it("reads total_slots, routes the model, forwards auth, and caches concurrent discovery", async () => {
		const fetchProps = vi.fn<typeof fetch>(async () =>
			Response.json({ total_slots: 2, default_generation_settings: { n_ctx: 262144 } }),
		);
		const resolver = new ClineTurnCapacityResolver(async () => null, fetchProps);
		expect(await Promise.all([resolver.resolve(target), resolver.resolve(target)])).toEqual([2, 2]);
		expect(fetchProps).toHaveBeenCalledTimes(1);
		const [url, init] = fetchProps.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://127.0.0.1:8080/props?model=qwen3.8-27b");
		expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("preserves reverse proxy prefixes and encodes model names", async () => {
		const fetchProps = vi.fn<typeof fetch>(async () => Response.json({ total_slots: 3 }));
		const resolver = new ClineTurnCapacityResolver(async () => null, fetchProps);
		await resolver.resolve({ ...target, baseUrl: "https://example.com/llm/v1", modelId: "org/model x" });
		expect(String(fetchProps.mock.calls[0]?.[0])).toBe("https://example.com/llm/props?model=org%2Fmodel+x");
	});

	it.each([
		{},
		{ total_slots: 0 },
		{ total_slots: -1 },
		{ total_slots: 1.5 },
		{ total_slots: "2" },
		{ total_slots: null },
	])("falls back to one for invalid metadata %j", async (data) => {
		const resolver = new ClineTurnCapacityResolver(
			async () => null,
			async () => Response.json(data),
		);
		expect(await resolver.resolve(target)).toBe(1);
	});

	it("falls back on HTTP errors and unreachable endpoints without failing the task", async () => {
		for (const fetchProps of [
			async () => new Response("missing", { status: 404 }),
			async () => {
				throw new Error("offline");
			},
		]) {
			expect(await new ClineTurnCapacityResolver(async () => null, fetchProps).resolve(target)).toBe(1);
		}
	});

	it("uses manual override immediately and resumes discovery when cleared", async () => {
		let override: number | null = 4;
		const fetchProps = vi.fn<typeof fetch>(async () => Response.json({ total_slots: 2 }));
		const resolver = new ClineTurnCapacityResolver(async () => override, fetchProps);
		expect(await resolver.resolve(target)).toBe(4);
		expect(fetchProps).not.toHaveBeenCalled();
		override = null;
		expect(await resolver.resolve(target)).toBe(2);
		override = 1;
		expect(await resolver.resolve(target)).toBe(1);
	});

	it("refreshes metadata after the cache TTL and does not probe providers without an explicit endpoint", async () => {
		vi.useFakeTimers();
		const fetchProps = vi.fn<typeof fetch>(async () => Response.json({ total_slots: 2 }));
		const resolver = new ClineTurnCapacityResolver(async () => null, fetchProps);
		expect(await resolver.resolve({ ...target, baseUrl: null })).toBe(1);
		expect(fetchProps).not.toHaveBeenCalled();
		await resolver.resolve(target);
		vi.advanceTimersByTime(30_001);
		await resolver.resolve(target);
		expect(fetchProps).toHaveBeenCalledTimes(2);
	});
});

describe("turn queue", () => {
	it("shares a two-turn budget across runtime owners, admits FIFO, and ignores idle sessions", async () => {
		const scheduler = new ClineTurnScheduler(async () => 2);
		const first = gate();
		const second = gate();
		const order: string[] = [];
		const owner = Symbol();
		const waiting = vi.fn();
		const run = (id: string, wait: Promise<void> = Promise.resolve(), scope = owner) =>
			scheduler.run(
				scope,
				id,
				target,
				async () => {
					order.push(id);
					await wait;
				},
				waiting,
			);
		const a = run("a", first.promise);
		const b = run("b", second.promise, Symbol("review-runtime"));
		const c = run("c");
		const d = run("d");
		try {
			await vi.waitFor(() => expect(order).toEqual(["a", "b"]));
			expect(waiting).toHaveBeenCalledWith(true);
			first.resolve();
			await Promise.all([a, c, d]);
			expect(order).toEqual(["a", "b", "c", "d"]);
			second.resolve();
			await b;
			await run("idle-follow-up");
			expect(order.at(-1)).toBe("idle-follow-up");
		} finally {
			first.resolve();
			second.resolve();
		}
	});

	it("isolates models and endpoints, while provider aliases on the same target share capacity", async () => {
		const scheduler = new ClineTurnScheduler(async () => 1);
		const hold = gate();
		const owner = Symbol();
		const active = scheduler.run(owner, "a", target, async () => hold.promise);
		try {
			await scheduler.run(owner, "other-model", { ...target, modelId: "another" }, async () => "ok");
			await scheduler.run(
				owner,
				"other-server",
				{ ...target, baseUrl: "http://localhost:9999/v1" },
				async () => "ok",
			);
			expect(clineTurnTargetKey({ ...target, providerId: "custom-alias", baseUrl: "http://127.0.0.1:8080" })).toBe(
				clineTurnTargetKey(target),
			);
		} finally {
			hold.resolve();
			await active;
		}
	});

	it("admits idle session setup without reserving or waiting for inference capacity", async () => {
		const capacity = vi.fn(async () => 1);
		const scheduler = new ClineTurnScheduler(capacity);
		const hold = gate();
		const active = scheduler.run(Symbol(), "active", target, async () => hold.promise);
		try {
			await vi.waitFor(() => expect(capacity).toHaveBeenCalledTimes(1));
			await expect(scheduler.run(Symbol(), "idle", target, async () => "ready", undefined, false)).resolves.toBe(
				"ready",
			);
			expect(capacity).toHaveBeenCalledTimes(1);
		} finally {
			hold.resolve();
			await active;
		}
	});

	it("releases capacity on errors", async () => {
		const scheduler = new ClineTurnScheduler(async () => 1);
		await expect(
			scheduler.run(Symbol(), "fail", target, async () => {
				throw new Error("bad turn");
			}),
		).rejects.toThrow("bad turn");
		await expect(scheduler.run(Symbol(), "next", target, async () => "ok")).resolves.toBe("ok");
	});

	it("cancels queued turns without affecting another owner and never starts them later", async () => {
		const scheduler = new ClineTurnScheduler(async () => 1);
		const hold = gate();
		const owner = Symbol();
		const active = scheduler.run(Symbol(), "a", target, async () => hold.promise);
		const operation = vi.fn(async () => "should not run");
		const waiting = vi.fn();
		const queued = scheduler.run(owner, "b", target, operation, waiting);
		const rejected = expect(queued).rejects.toThrow("Cline turn canceled");
		try {
			await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true));
			scheduler.cancel(owner);
			await rejected;
			hold.resolve();
			await active;
			expect(operation).not.toHaveBeenCalled();
		} finally {
			hold.resolve();
		}
	});

	it("cancels while capacity is being discovered before starting any SDK work", async () => {
		const discovery = gate();
		const scheduler = new ClineTurnScheduler(async () => {
			await discovery.promise;
			return 2;
		});
		const owner = Symbol();
		const operation = vi.fn(async () => "unexpected");
		const pending = scheduler.run(owner, "task", target, operation);
		const rejected = expect(pending).rejects.toThrow("Cline turn canceled");
		scheduler.cancel(owner, "task");
		discovery.resolve();
		await rejected;
		expect(operation).not.toHaveBeenCalled();
	});
});
