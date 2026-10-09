// PRTRACK-1: explicit consumer registry (the "installed consumers" signal).
//
// Registration is explicit at runtime — production registers the merge
// completion consumer (MERGE-1); tests register fake consumers. An enabled
// checkbox against an unregistered consumer never produces API demand and
// renders as "Feature unavailable" in the UI.
//
// Consumers observe the coordinator's reads: the coordinator delivers one
// observation per active task subscription after every successful read
// (after the authoritative state effects were applied). Observers must be
// idempotent and bounded; the coordinator never re-invokes them for stopped
// subscriptions.
import type {
	GitHubPrNormalizedSnapshot,
	GitHubPrTaskIdentity,
	GitHubPrTrackingRecord,
	RuntimePrConsumerKind,
	RuntimePrConsumerReadSource,
} from "../core/api-contract";

/**
 * Per-consumer demand rule: every installed consumer requests metadata
 * reads; only the comment consumer requests the feedback/review/thread
 * sources. A comment-only task therefore needs no further reads once the
 * PR is in a terminal state (metadata alone carries the state transition).
 */
export const PR_CONSUMER_READ_SOURCES: Record<RuntimePrConsumerKind, RuntimePrConsumerReadSource[]> = {
	comments: ["metadata", "reviews", "conversationComments", "inlineComments", "threads"],
	mergeCompletion: ["metadata"],
};

export interface PrConsumerRegistration {
	kind: RuntimePrConsumerKind;
	requiredReadSources: RuntimePrConsumerReadSource[];
	registeredAt: number;
	/**
	 * The consumer's observation hook, invoked by the coordinator for every
	 * active task subscription after a successful read. Observers reconcile
	 * authoritative state (the observation record + snapshot are fresh, but
	 * the observer must re-read durable state before writing) and must be
	 * idempotent: the same observation can be redelivered after a restart.
	 */
	onObservation?: (observation: PrConsumerObservation) => unknown | Promise<unknown>;
}

/**
 * One coordinator read, delivered to a consumer for the task subscription
 * that demanded it. `snapshot` is the same authorized data every consumer
 * sees for the subscription; `record` is the record state right after the
 * read's authoritative effects were applied.
 */
export interface PrConsumerObservation {
	task: GitHubPrTaskIdentity;
	record: GitHubPrTrackingRecord;
	snapshot: GitHubPrNormalizedSnapshot;
	installedConsumers: PrInstalledConsumers;
	now: number;
}

export interface PrInstalledConsumers {
	comments: boolean;
	mergeCompletion: boolean;
}

export class PrConsumerRegistry {
	private readonly registrations = new Map<RuntimePrConsumerKind, PrConsumerRegistration>();
	private readonly now: () => number;

	constructor(options?: { now?: () => number }) {
		this.now = options?.now ?? Date.now;
	}

	/** Explicit runtime registration. Re-registering a kind refreshes its sources. */
	registerConsumer(kind: RuntimePrConsumerKind, requiredReadSources?: RuntimePrConsumerReadSource[]): void {
		this.registrations.set(kind, {
			kind,
			requiredReadSources: requiredReadSources ?? [...PR_CONSUMER_READ_SOURCES[kind]],
			registeredAt: this.now(),
		});
	}

	/**
	 * Register a consumer with its observation hook. The kind's default read
	 * sources apply when none are supplied.
	 */
	register(registration: {
		kind: RuntimePrConsumerKind;
		requiredReadSources?: RuntimePrConsumerReadSource[];
		onObservation?: PrConsumerRegistration["onObservation"];
	}): void {
		this.registrations.set(registration.kind, {
			kind: registration.kind,
			requiredReadSources: registration.requiredReadSources ?? [...PR_CONSUMER_READ_SOURCES[registration.kind]],
			registeredAt: this.now(),
			...(registration.onObservation !== undefined ? { onObservation: registration.onObservation } : {}),
		});
	}

	unregisterConsumer(kind: RuntimePrConsumerKind): void {
		this.registrations.delete(kind);
	}

	isInstalled(kind: RuntimePrConsumerKind): boolean {
		return this.registrations.has(kind);
	}

	getInstalled(kind: RuntimePrConsumerKind): PrConsumerRegistration | null {
		return this.registrations.get(kind) ?? null;
	}

	listInstalled(): PrConsumerRegistration[] {
		return [...this.registrations.values()];
	}

	isAnyInstalled(): boolean {
		return this.registrations.size > 0;
	}

	/**
	 * The demand rule: which read sources are required by the installed
	 * consumers. Empty when nothing is installed (no reads demanded).
	 */
	requiredReadSources(): Set<RuntimePrConsumerReadSource> {
		const sources = new Set<RuntimePrConsumerReadSource>();
		for (const registration of this.registrations.values()) {
			for (const source of registration.requiredReadSources) {
				sources.add(source);
			}
		}
		return sources;
	}
}

/** The installed-consumer flags used by subscription demand and the UI. */
export function toInstalledConsumerFlags(registry: PrConsumerRegistry): PrInstalledConsumers {
	return {
		comments: registry.isInstalled("comments"),
		mergeCompletion: registry.isInstalled("mergeCompletion"),
	};
}
