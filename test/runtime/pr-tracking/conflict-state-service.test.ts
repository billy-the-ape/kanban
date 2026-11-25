// PCR-1: the conflict-state provider behind `getTaskTrackingState`.
// The panel must answer from durable knowledge without blocking on network
// or git: lazy snapshot top-ups, cached background probes only while no
// provider snapshot exists, and a Re-check that forces exactly one read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPrMetadataSnapshot } from "../../../src/core/api-contract";
import {
	type ConflictStateQuery,
	type ConflictStateServiceDeps,
	createConflictStateService,
} from "../../../src/pr-tracking/conflict-state-service";
import { InMemoryPrRecordStore } from "../../../src/pr-tracking/in-memory-pr-record-store";
import type { PrTrackingCoordinator } from "../../../src/pr-tracking/pr-tracking-coordinator";
import type { MergeProbeRunner } from "../../../src/workspace/pr-merge-probe";

const PR_KEY = "github|github.com|octo/repo|42";

const baseQuery: ConflictStateQuery = {
	workspaceId: "/workspace/repo",
	workspacePath: "/workspace/repo",
	taskId: "task-1",
	prKey: PR_KEY,
	baseRef: "main",
	provider: "github",
	host: "github.com",
	repository: "octo/repo",
	active: true,
};

function makeSnapshot(overrides: Partial<GitHubPrMetadataSnapshot> = {}): GitHubPrMetadataSnapshot {
	return {
		accessScopeId: "scope-1",
		checkedAt: 1_000,
		state: "open",
		headRepository: "octo/repo",
		headRef: "feature",
		baseRepository: "octo/repo",
		baseRef: "main",
		headSha: "abc1234def5678",
		mergedAt: null,
		mergeCommitSha: null,
		baseSha: "beef1234",
		mergeable: null,
		mergeableState: null,
		autoMergePresent: false,
		...overrides,
	} as unknown as GitHubPrMetadataSnapshot;
}

type ProbeStepResult = Awaited<ReturnType<MergeProbeRunner>>;

function step(ok: boolean, stdout = "", exitCode = ok ? 0 : 128): ProbeStepResult {
	return {
		ok,
		stdout,
		stderr: ok ? "" : "boom",
		exitCode,
	} as ProbeStepResult;
}

/** A merge-tree-shaped fake runner: fetch succeeds, merge-tree conflicts. */
function conflictingProbeRunner(): MergeProbeRunner {
	return vi.fn(async (_cwd: string, args: string[]) => {
		if (args[0] === "check-ref-format") return step(true);
		if (args[0] === "rev-parse" && args[1] === "HEAD") return step(true, "headshead\n");
		if (args[0] === "remote") return step(true, "origin\n");
		if (args[0] === "fetch") return step(true);
		if (args[0] === "rev-parse") return step(true, "basetipsha\n");
		if (args[0] === "merge-tree") return step(false, "tree\nCONFLICT (content): file.ts\n", 1);
		return step(true);
	}) as unknown as MergeProbeRunner;
}

let nowValue = 100_000;
let refreshes: string[] = [];
let store: InMemoryPrRecordStore;

async function seed(snapshot: GitHubPrMetadataSnapshot | null): Promise<void> {
	await store.createRecord({
		canonicalPrKey: PR_KEY,
		provider: "github",
		host: "github.com",
		repository: "octo/repo",
		number: 42,
	});
	if (snapshot === null) {
		return;
	}
	await store.withRegistryTransaction(async (registry) => {
		const state = await registry.loadState(PR_KEY);
		if (state.kind !== "present") throw new Error("record missing");
		await registry.write(PR_KEY, {
			...state.record,
			revision: state.record.revision + 1,
			snapshots: { "scope-1": snapshot },
		});
	});
}

function createService(overrides: Partial<ConflictStateServiceDeps> = {}) {
	const coordinator = {
		refreshPrMetadataOnce: vi.fn(async (key: string) => {
			refreshes.push(key);
			return { outcome: "refreshed" as const, metadata: null };
		}),
	} as unknown as PrTrackingCoordinator;
	const deps: ConflictStateServiceDeps = {
		getCoordinator: () => coordinator,
		getStore: () => store,
		resolveWorktreePath: async () => "/workspace/repo/.worktrees/task-1",
		probeRunner: conflictingProbeRunner(),
		now: () => nowValue,
		...overrides,
	};
	return { service: createConflictStateService(deps), coordinator };
}

beforeEach(() => {
	nowValue = 100_000;
	refreshes = [];
	store = new InMemoryPrRecordStore();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("conflict-state service", () => {
	it("answers from a fresh conflicting snapshot without touching the network", async () => {
		await seed(makeSnapshot({ checkedAt: 99_000, mergeable: false, mergeableState: "dirty" }));
		const { service, coordinator } = createService();
		const conflict = await service.compute(baseQuery);
		expect(conflict).toMatchObject({ state: "conflicting", source: "provider_snapshot" });
		expect(coordinator.refreshPrMetadataOnce).not.toHaveBeenCalled();
	});

	it("fires one lazy top-up when the snapshot is stale, without blocking the answer", async () => {
		await seed(makeSnapshot({ checkedAt: 1_000, mergeable: null }));
		const { service, coordinator } = createService();
		const conflict = await service.compute(baseQuery);
		// The answer comes from what is known; the refresh lands in the record
		// and the next panel poll sees it.
		expect(conflict.state).toBe("unknown");
		expect(coordinator.refreshPrMetadataOnce).toHaveBeenCalledWith(PR_KEY);
		// Debounced: a second compute inside the interval does not re-read.
		await service.compute(baseQuery);
		expect(coordinator.refreshPrMetadataOnce).toHaveBeenCalledTimes(1);
	});

	it("Re-check forces exactly one provider read even when the snapshot is fresh", async () => {
		await seed(makeSnapshot({ checkedAt: 99_000, mergeable: null }));
		const { service, coordinator } = createService();
		const conflict = await service.recheck(baseQuery);
		expect(coordinator.refreshPrMetadataOnce).toHaveBeenCalledTimes(1);
		expect(conflict.source).toBe("provider_snapshot");
	});

	it("runs a local probe only while no provider snapshot exists", async () => {
		await seed(null);
		const runner = conflictingProbeRunner();
		const { service } = createService({ probeRunner: runner });
		const conflict = await service.compute(baseQuery);
		// The first compute schedules the probe; the answer is honest about
		// knowing nothing yet.
		expect(conflict.state).toBe("unknown");
		// Let the background probe settle, then ask again: the cached probe
		// result surfaces as a LOCAL conflict, never a provider claim.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const after = await service.compute(baseQuery);
		expect(after.state).toBe("conflicting");
		expect(after.source).toBe("local_probe");
		expect(after.note).toContain("local merge probe");
	});

	it("never probes when a provider snapshot exists or the card is inactive", async () => {
		await seed(makeSnapshot({ checkedAt: 99_000, mergeable: true }));
		const runner = conflictingProbeRunner();
		const { service } = createService({ probeRunner: runner });
		await service.compute(baseQuery);
		await service.compute({ ...baseQuery, active: false });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runner).not.toHaveBeenCalled();
	});

	it("reports unsupported for hosts without metadata reads and no probe", async () => {
		await seed(null);
		const { service } = createService({
			probeRunner: vi.fn(async () => {
				throw new Error("must not run");
			}) as unknown as MergeProbeRunner,
			resolveWorktreePath: async () => null,
		});
		const conflict = await service.compute({
			...baseQuery,
			provider: "gitlab",
			host: "gitlab.com",
		});
		expect(conflict.state).toBe("unsupported");
	});
});
