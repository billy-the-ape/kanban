// PRTRACK-0: deterministic in-memory PR record store.
//
// Implements the exact CAS semantics of the disk store without fs I/O or
// lockfile retry timers, so coordinator tests can run under fake timers with
// exact timing assertions and shared-state checks (two coordinators, one
// store). Records live only for the process; never a production backend.
import type { GitHubPrTrackingRecord } from "../core/api-contract";
import type { PrRecordIo, PrRecordState, PrRegistryAccess } from "./pr-record-store";
import { PrRecordStoreBase } from "./pr-record-store";

export interface InMemoryPrRecordStoreOptions {
	now?: () => number;
}

export class InMemoryPrRecordStore extends PrRecordStoreBase {
	private readonly records = new Map<string, GitHubPrTrackingRecord>();
	private readonly now: () => number;
	/**
	 * Serializes transactions so multi-record gate checks stay atomic with
	 * respect to single-record CAS operations within the process.
	 */
	private transactionChain: Promise<unknown> = Promise.resolve();

	constructor(options: InMemoryPrRecordStoreOptions = {}) {
		super();
		this.now = options.now ?? Date.now;
	}

	private stateFor(canonicalPrKey: string): PrRecordState {
		const current = this.records.get(canonicalPrKey) ?? null;
		return current ? { kind: "present", record: current } : { kind: "absent" };
	}

	protected nowValue(): number {
		return this.now();
	}

	protected async withRecord<T>(
		canonicalPrKey: string,
		op: (state: PrRecordState, io: PrRecordIo) => T | Promise<T>,
	): Promise<T> {
		return await this.enqueueTransaction(async () => {
			const current = this.records.get(canonicalPrKey) ?? null;
			const state: PrRecordState = current ? { kind: "present", record: current } : { kind: "absent" };
			const io: PrRecordIo = {
				write: async (record) => {
					this.records.set(canonicalPrKey, record);
				},
				remove: async () => {
					this.records.delete(canonicalPrKey);
				},
			};
			return await op(state, io);
		});
	}

	async withRegistryTransaction<T>(op: (registry: PrRegistryAccess) => T | Promise<T>): Promise<T> {
		return await this.enqueueTransaction(async () => {
			const registry: PrRegistryAccess = {
				loadState: async (key) => this.stateFor(key),
				write: async (key, record) => {
					this.records.set(key, record);
				},
				remove: async (key) => {
					this.records.delete(key);
				},
				listRecords: async () => [...this.records.values()],
			};
			return await op(registry);
		});
	}

	private async enqueueTransaction<T>(op: () => Promise<T>): Promise<T> {
		const next = this.transactionChain.then(async () => {
			return await op();
		});
		this.transactionChain = next.then(
			() => undefined,
			() => undefined,
		);
		return await next;
	}

	async listRecords(): Promise<{ records: GitHubPrTrackingRecord[]; malformedFiles: string[] }> {
		return { records: [...this.records.values()], malformedFiles: [] };
	}
}
