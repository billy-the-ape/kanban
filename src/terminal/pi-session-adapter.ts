// AA-P1: the Pi (`pi` CLI from @earendil-works/pi-coding-agent) session adapter.
//
// Kanban launches the TUI directly in the task worktree, pins the exact Pi
// session it owns (`--session-dir` + a Kanban-minted `--session-id`), and loads
// one generated extension for lifecycle events. Pi keeps its own tools, prompt,
// user extensions and provider configuration.
import { formatUnsupportedAgentLaunchError, getUnsupportedAgentLaunchOperations } from "../core/agent-capabilities";
import { PR_CI_HANDOFF_GUIDANCE } from "../prompts/pr-ci-handoff";
import {
	createScopedHookResources,
	ensureTextFile,
	getScopedHookAgentDirectory,
	resolveHookContext,
	withPrompt,
} from "./agent-launch-helpers";
import type { AgentAdapterLaunchInput, AgentSessionAdapter, PreparedAgentLaunch } from "./agent-session-adapters";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { buildPiHookExtensionSource, getPiHookExtensionPath } from "./pi-hook-extension";
import {
	buildPiLaunchArgs,
	derivePiSessionId,
	getPiTaskSessionDir,
	readPiModelDefaults,
	readPiSessionRecord,
	resolvePiModelFlags,
} from "./pi-session-options";

/** Pi sessions live under a Kanban-owned directory per workspace/task. */
const PI_UNSCOPED_WORKSPACE_ID = "__home__";

interface PiLaunchScope {
	workspaceId: string;
	taskId: string;
}

function resolvePiScope(input: AgentAdapterLaunchInput): PiLaunchScope {
	return {
		workspaceId: input.workspaceId?.trim() || PI_UNSCOPED_WORKSPACE_ID,
		taskId: input.taskId,
	};
}

/**
 * Pi has no plan mode and no approval-bypass flag. The plan-mode request is
 * refused by name instead of quietly starting an Act-mode run, and the missing
 * approval switch is disclosed in settings rather than invented here.
 */
export function assertPiLaunchIsSupported(input: AgentAdapterLaunchInput): void {
	const unsupported = getUnsupportedAgentLaunchOperations("pi", {
		startInPlanMode: input.startInPlanMode,
		// Images travel through Kanban's shared temp-file prompt like every other
		// terminal agent, so nothing is dropped here.
		imagesRequested: false,
		// Pi executes tools without asking, so there is nothing to bypass.
		autonomousModeRequested: false,
	});
	const message = formatUnsupportedAgentLaunchError("pi", unsupported);
	if (message) {
		throw new Error(message);
	}
}

export interface PiPreparedLaunch extends PreparedAgentLaunch {
	/** Pi session identity and location this launch owns. */
	session: {
		sessionId: string;
		sessionDir: string;
		/** True when Pi's session file for this task already existed. */
		resumed: boolean;
		sessionFile: string | null;
	};
	/** Model flags forwarded from Pi's own settings, when explicitly configured. */
	modelArgs: string[];
}

/**
 * Keep CI monitoring out of autonomous coding turns. Existing PR and repair
 * templates already include this guidance; do not duplicate it or submit
 * an empty restoration prompt (which would accidentally start a new turn).
 */
export function withPiCiHandoffGuidance(prompt: string): string {
	if (!prompt.trim() || prompt.includes(PR_CI_HANDOFF_GUIDANCE)) return prompt;
	return `${prompt.trimEnd()}\n\n${PR_CI_HANDOFF_GUIDANCE}`;
}

/**
 * Builds one Pi launch: the exact-session flags, the generated hook extension,
 * the model request forwarded from Pi's own settings, and the durable session
 * Kanban is about to continue.
 */
export async function preparePiLaunch(input: AgentAdapterLaunchInput): Promise<PiPreparedLaunch> {
	assertPiLaunchIsSupported(input);

	const scope = resolvePiScope(input);
	const sessionDir = getPiTaskSessionDir(scope);
	const sessionId = derivePiSessionId(scope);
	const hooks = resolveHookContext(input);

	const extensionPath = hooks ? getPiHookExtensionPath(getScopedHookAgentDirectory("pi", hooks)) : null;
	// Pi's own settings decide the model; Kanban only repeats that decision
	// explicitly instead of letting a hosted default slip in.
	const modelFlags = resolvePiModelFlags(await readPiModelDefaults());
	const args = buildPiLaunchArgs({
		args: input.args,
		sessionDir,
		sessionId,
		extensionPath,
		modelArgs: modelFlags.args,
	});

	if (extensionPath) {
		await ensureTextFile(extensionPath, buildPiHookExtensionSource({ sessionId }));
	}

	// Kanban names the session it owns, so “resume” is a fact about the durable
	// file rather than a guess at Pi's most recent conversation.
	const record = await readPiSessionRecord({ sessionId, sessionDir });
	// Pi reads options until `--`, so a task description that starts with a dash
	// stays data instead of becoming an option Pi never intended.
	const withPromptLaunch = withPrompt([...args, "--"], withPiCiHandoffGuidance(input.prompt), "append");
	const env: Record<string, string | undefined> = { ...withPromptLaunch.env };
	if (hooks) {
		Object.assign(env, createHookRuntimeEnv(hooks));
	}
	const resources = hooks ? createScopedHookResources("pi", hooks) : null;

	return {
		...withPromptLaunch,
		env,
		...(resources ? { cleanup: resources.cleanup } : {}),
		session: {
			sessionId,
			sessionDir,
			resumed: record.found,
			sessionFile: record.sessionFile,
		},
		modelArgs: modelFlags.args,
	};
}

export const piAdapter: AgentSessionAdapter = {
	async prepare(input) {
		// The terminal manager only understands the launch contract, so the Pi
		// session evidence stays out of it and is asserted through
		// `preparePiLaunch` where it is actionable.
		const { session: _session, modelArgs: _modelArgs, ...prepared } = await preparePiLaunch(input);
		return prepared;
	},
};
