// Task-scoped resolution of the native Cline launch config for session
// restarts (pause → change the card model → resume).
//
// The session runtime restarts a session by re-resolving its launch policy
// through the injected `ClineLaunchConfigResolver` (B-2.8). Until now the
// runtime always pinned the saved provider/model, so a paused task resumed
// with the model it started with even after the user saved a different one
// on the card. This wrapper restores the fresh-launch precedence at the
// restart boundary:
//
//   1. The restarting session's task card exists → resolve from the card's
//      CURRENT `clineSettings` (exactly what `startTaskSession` in
//      runtime-api.ts sends for a fresh start: card overrides win; a card
//      with no override object falls through to the current global provider
//      settings; an override object without `reasoningEffort` explicitly
//      clears reasoning).
//   2. No card owns the session id (home-agent sidebar sessions, review and
//      verification-repair roles, deleted cards) → keep the B-2.8 pinning of
//      the saved provider/model so those conversations continue unchanged.
//
// Card lookup goes through the persisted workspace board, so this also works
// after a Kanban process restart (the runtime reconstructs the start request
// from the durable session record, then the wrapper re-resolves from the
// card).
import type { RuntimeClineReasoningEffort, RuntimeTaskClineSettings } from "../core/api-contract";
import type { ResolvedClineLaunchConfig } from "./cline-provider-service";
import type { ClineLaunchConfigResolver } from "./cline-session-runtime";

/** The subset of a board card that drives per-task launch precedence. */
export interface TaskLaunchConfigCard {
	clineSettings?: RuntimeTaskClineSettings;
}

export interface TaskScopedLaunchConfigOverrides {
	providerIdOverride?: string;
	modelIdOverride?: string;
	reasoningEffortOverride?: RuntimeClineReasoningEffort | null;
}

export interface CreateTaskScopedClineLaunchConfigResolverDependencies {
	/** The provider service's resolver; resolves global provider settings when overrides are omitted. */
	resolveLaunchConfig: (overrides: TaskScopedLaunchConfigOverrides) => Promise<ResolvedClineLaunchConfig>;
	/** Board card for the restarting session id; null when no card owns it. */
	loadTaskCard: (taskId: string) => Promise<TaskLaunchConfigCard | null>;
}

export function createTaskScopedClineLaunchConfigResolver(
	deps: CreateTaskScopedClineLaunchConfigResolverDependencies,
): ClineLaunchConfigResolver {
	return async (overrides) => {
		if (overrides.taskId) {
			let card: TaskLaunchConfigCard | null = null;
			try {
				card = await deps.loadTaskCard(overrides.taskId);
			} catch {
				// A failed board read must not break the resume turn; fall back to
				// the pinned saved configuration (B-2.8 behavior).
			}
			if (card) {
				const hasTaskLevelClineSettingsOverride = card.clineSettings !== undefined;
				return deps.resolveLaunchConfig({
					providerIdOverride: card.clineSettings?.providerId ?? undefined,
					modelIdOverride: card.clineSettings?.modelId ?? undefined,
					...(hasTaskLevelClineSettingsOverride
						? { reasoningEffortOverride: card.clineSettings?.reasoningEffort ?? null }
						: {}),
				});
			}
		}
		return deps.resolveLaunchConfig({
			providerIdOverride: overrides.providerIdOverride,
			modelIdOverride: overrides.modelIdOverride,
		});
	};
}
