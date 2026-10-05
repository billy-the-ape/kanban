import { readGlobalRuntimeClineConcurrencyLimit } from "../config/runtime-config";

export interface ClineTurnTarget {
	providerId: string;
	modelId: string | null;
	baseUrl?: string | null;
	apiKey?: string | null;
}

function endpointRoot(target: ClineTurnTarget): string | null {
	if (!target.baseUrl) return null;
	try {
		const url = new URL(target.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.search = "";
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

export function clineTurnTargetKey(target: ClineTurnTarget): string {
	return JSON.stringify([endpointRoot(target) ?? target.providerId, target.modelId]);
}

/** Discover running llama-server capacity through llama-swap; never infer it from context size. */
export class ClineTurnCapacityResolver {
	private readonly cache = new Map<string, { expiresAt: number; value: Promise<number> }>();

	constructor(
		private readonly readOverride = readGlobalRuntimeClineConcurrencyLimit,
		private readonly fetchProps: typeof fetch = fetch,
	) {}

	async resolve(target: ClineTurnTarget): Promise<number> {
		const override = await this.readOverride();
		if (override !== null) return override;
		const root = endpointRoot(target);
		if (!root || !target.modelId) return 1;
		const key = clineTurnTargetKey(target);
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const value = this.discover(root, target);
		this.cache.set(key, { expiresAt: Date.now() + 30_000, value });
		return value;
	}

	private async discover(root: string, target: ClineTurnTarget): Promise<number> {
		try {
			const url = new URL(`${root}/props`);
			url.searchParams.set("model", target.modelId ?? "");
			const response = await this.fetchProps(url, {
				headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
				signal: AbortSignal.timeout(2_500),
			});
			if (!response.ok) return 1;
			const data: unknown = await response.json();
			const slots = data && typeof data === "object" && "total_slots" in data ? data.total_slots : null;
			return typeof slots === "number" && Number.isSafeInteger(slots) && slots > 0 ? slots : 1;
		} catch {
			return 1;
		}
	}
}

interface TurnEntry {
	owner: symbol;
	taskId: string;
	controller: AbortController;
}

interface TurnWaiter {
	entry: TurnEntry;
	limit: number;
	resolve: (release: () => void) => void;
	reject: (error: unknown) => void;
	onState?: (queued: boolean, queuePosition?: number) => void;
	queuePosition?: number;
}

interface TurnPool {
	active: number;
	waiters: TurnWaiter[];
}

const defaultCapacityResolver = new ClineTurnCapacityResolver();

/** FIFO admission around complete SDK turns, shared by implementation, home and review runtimes. */
export class ClineTurnScheduler {
	private readonly pools = new Map<string, TurnPool>();
	private readonly entries = new Set<TurnEntry>();

	constructor(
		private readonly resolveCapacity: (target: ClineTurnTarget) => Promise<number> = (target) =>
			defaultCapacityResolver.resolve(target),
	) {}

	async run<T>(
		owner: symbol,
		taskId: string,
		target: ClineTurnTarget,
		operation: (signal: AbortSignal) => Promise<T>,
		onState?: (queued: boolean, queuePosition?: number) => void,
		requiresCapacity = true,
	): Promise<T> {
		const entry: TurnEntry = { owner, taskId, controller: new AbortController() };
		this.entries.add(entry);
		let release: (() => void) | undefined;
		try {
			if (!requiresCapacity) return await operation(entry.controller.signal);
			const limit = await this.resolveCapacity(target);
			entry.controller.signal.throwIfAborted();
			const key = clineTurnTargetKey(target);
			const pool = this.pools.get(key) ?? { active: 0, waiters: [] };
			this.pools.set(key, pool);
			release = await new Promise<() => void>((resolve, reject) => {
				const waiter: TurnWaiter = { entry, limit, resolve, reject, onState };
				pool.waiters.push(waiter);
				entry.controller.signal.addEventListener("abort", () => this.drain(key, pool), { once: true });
				this.drain(key, pool);
			});
			entry.controller.signal.throwIfAborted();
			return await operation(entry.controller.signal);
		} finally {
			this.entries.delete(entry);
			release?.();
		}
	}

	cancel(owner: symbol, taskId?: string): void {
		for (const entry of this.entries) {
			if (entry.owner === owner && (taskId === undefined || entry.taskId === taskId)) {
				entry.controller.abort(new Error("Cline turn canceled."));
			}
		}
	}

	private drain(key: string, pool: TurnPool): void {
		pool.waiters = pool.waiters.filter((waiter) => {
			if (!waiter.entry.controller.signal.aborted) return true;
			waiter.reject(waiter.entry.controller.signal.reason);
			return false;
		});
		while (pool.waiters.length > 0) {
			const waiter = pool.waiters[0];
			if (!waiter || pool.active >= waiter.limit) break;
			pool.waiters.shift();
			pool.active += 1;
			waiter.onState?.(false);
			waiter.resolve(() => {
				pool.active -= 1;
				this.drain(key, pool);
			});
		}
		pool.waiters.forEach((waiter, index) => {
			const position = index + 1;
			if (waiter.queuePosition === position) return;
			waiter.queuePosition = position;
			waiter.onState?.(true, position);
		});
		if (pool.active === 0 && pool.waiters.length === 0) this.pools.delete(key);
	}
}

export const sharedClineTurnScheduler = new ClineTurnScheduler();
