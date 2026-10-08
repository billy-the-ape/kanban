// PRTRACK-1: explicit consumer registry (the "installed consumers" signal).
//
// Registration is explicit at runtime — this slice registers nothing in
// production. The comment consumer lands with COMMENT-0 and the merge
// consumer with MERGE-1; tests register fake consumers. An enabled checkbox
// against an unregistered consumer never produces API demand and renders as
// "Feature unavailable" in the UI.
import type { RuntimePrConsumerKind, RuntimePrConsumerReadSource } from "../core/api-contract";

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
