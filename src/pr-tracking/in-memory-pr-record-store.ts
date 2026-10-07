// PRTRACK-0: deterministic in-memory PR record store.
//
// Implements the exact CAS semantics of the disk store without fs I/O or
// lockfile retry timers, so coordinator tests can run under fake timers with
// exact timing assertions and shared-state checks (two coordinators, one
// store). Records live only for the process; never a production backend.
import type { GitHubPrTrackingRecord } from "../core/api-contract";
import type { PrRecordIo, PrRecordState } from "./pr-record-store";
import { PrRecordStoreBase } from "./pr-record-store";

export interface InMemoryPrRecordStoreOptions {
	now?: () => number;
}

export class InMemoryPrRecordStore extends PrRecordStoreBase {
	private readonly records = new Map<string, GitHubPrTrackingRecord>();
	private readonly now: () => number;

	constructor(options: InMemoryPrRecordStoreOptions = {}) {
		super();
		this.now = options.now ?? Date.now;
	}

	protected nowValue(): number {
		return this.now();
	}

	protected async withRecord<T>(
		canonicalPrKey: string,
		op: (state: PrRecordState, io: PrRecordIo) => T | Promise<T>,
	): Promise<T> {
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
	}

	async listRecords(): Promise<{ records: GitHubPrTrackingRecord[]; malformedFiles: string[] }> {
		return { records: [...this.records.values()], malformedFiles: [] };
	}
}
