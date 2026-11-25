// PCR-1: the pure conflict-state resolution rule.
//
// Turns the provider-authoritative metadata snapshot (github.com) and/or the
// advisory local merge probe into one `RuntimePrConflictState` block, in the
// plan's fixed precedence:
//
// 1. Provider snapshot (authoritative): `mergeable === false` → conflicting;
//    `mergeable === true` → clean; `mergeable === null` → unknown (GitHub
//    computes mergeability asynchronously, so `null` is the common case for a
//    freshly pushed head, never a green light and never a conflict). A
//    `mergeable_state === "dirty"` hint is a corroborating signal only — it
//    can never make the state conflicting on its own.
// 2. Local probe (fallback for GHE/GitLab/no gh): advisory. A conflicting
//    probe surfaces the repair trigger with `source: "local_probe"`; a clean
//    probe is NEVER rendered as clean, because the probe cannot see the
//    provider's merge drivers and must not claim a green light.
// 3. Otherwise unknown/unsupported with an explanatory `note`.
import type { GitHubPrMetadataSnapshot, GitHubPrTrackingRecord, RuntimePrConflictState } from "../core/api-contract";

export type PrConflictProbeOutcome = "clean" | "conflicting" | "failed";

export interface PrConflictProbeView {
	outcome: PrConflictProbeOutcome;
	error?: string | null;
	baseSha?: string | null;
	headSha?: string | null;
	baseRef?: string | null;
	checkedAt?: number | null;
}

export interface ResolvePrConflictStateInput {
	/** Canonical PR key the block is scoped to. */
	prKey: string;
	/** The newest access-scoped provider snapshot, or null when none exists. */
	snapshot: GitHubPrMetadataSnapshot | null;
	/** True when the PR's host supports provider metadata reads (github.com). */
	providerSupported: boolean;
	/** The cached local probe result, if a probe has completed. */
	probe?: PrConflictProbeView | null;
}

/**
 * The newest snapshot across every access scope of a tracking record (the
 * conflict display is provider truth of whichever scope read last; freshness
 * is governed by staleness, not scope identity).
 */
export function latestSnapshotFromRecord(record: GitHubPrTrackingRecord | null): GitHubPrMetadataSnapshot | null {
	if (record === null) {
		return null;
	}
	let latest: GitHubPrMetadataSnapshot | null = null;
	for (const snapshot of Object.values(record.snapshots)) {
		if (latest === null || snapshot.checkedAt > latest.checkedAt) {
			latest = snapshot;
		}
	}
	return latest;
}

function emptyBlock(prKey: string): Omit<RuntimePrConflictState, "state" | "source" | "note"> {
	return {
		prKey,
		headRef: null,
		baseRef: null,
		headSha: null,
		baseSha: null,
		checkedAt: null,
	};
}

export function resolvePrConflictState(input: ResolvePrConflictStateInput): RuntimePrConflictState {
	const { prKey, snapshot, providerSupported, probe } = input;
	const base = emptyBlock(prKey);
	if (snapshot !== null) {
		const identity = {
			...base,
			headRef: snapshot.headRef,
			baseRef: snapshot.baseRef,
			headSha: snapshot.headSha,
			baseSha: snapshot.baseSha ?? null,
			checkedAt: snapshot.checkedAt,
		};
		if (snapshot.mergeable === false) {
			return {
				...identity,
				state: "conflicting",
				source: "provider_snapshot",
				note: "The current head does not merge cleanly into the base branch.",
			};
		}
		if (snapshot.mergeable === true) {
			return { ...identity, state: "clean", source: "provider_snapshot", note: null };
		}
		return {
			...identity,
			state: "unknown",
			source: "provider_snapshot",
			note:
				snapshot.mergeableState === "dirty"
					? "GitHub has not confirmed mergeability for the current head (its merge-state hint reports dirty)."
					: "GitHub is still computing mergeability for the current head.",
		};
	}
	if (probe && probe.outcome === "conflicting") {
		return {
			...base,
			headRef: null,
			baseRef: probe.baseRef ?? null,
			headSha: probe.headSha ?? null,
			baseSha: probe.baseSha ?? null,
			checkedAt: probe.checkedAt ?? null,
			state: "conflicting",
			source: "local_probe",
			note: providerSupported
				? "Reported by a local merge probe: the current head does not merge cleanly into the latest base. GitHub has not reported mergeability yet."
				: "Reported by a local merge probe: the current head does not merge cleanly into the latest base. This host's provider mergeability cannot be read by Kanban.",
		};
	}
	if (probe && probe.outcome === "clean") {
		// Advisory only: a local clean is never rendered as a provider-confirmed
		// clean merge.
		return {
			...base,
			baseRef: probe.baseRef ?? null,
			headSha: probe.headSha ?? null,
			baseSha: probe.baseSha ?? null,
			checkedAt: probe.checkedAt ?? null,
			state: "unknown",
			source: "local_probe",
			note: "A local merge probe found no conflicts; the provider has not confirmed mergeability.",
		};
	}
	if (!providerSupported) {
		return {
			...base,
			state: "unsupported",
			source: "none",
			note:
				probe && probe.outcome === "failed" && probe.error
					? probe.error
					: "Mergeability cannot be read for this host, and no local probe has completed.",
		};
	}
	return {
		...base,
		state: "unknown",
		source: "none",
		note:
			probe && probe.outcome === "failed" && probe.error
				? probe.error
				: "No provider snapshot yet; Kanban is reading the PR metadata from the provider.",
	};
}
