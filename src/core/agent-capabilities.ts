import { getRuntimeAgentCatalogEntry } from "./agent-catalog";
import type {
	RuntimeAgentCapabilities,
	RuntimeAgentId,
	RuntimeAgentLaunchOperation,
	RuntimeAgentModelConfiguration,
} from "./api-contract";

/**
 * AA-S1: the single source of truth for what each catalogued agent can be
 * asked to do. Values are read from the agent adapters in
 * `src/terminal/agent-session-adapters.ts` — when an adapter gains (or loses)
 * a flag, update the row here too, because callers gate on this table instead
 * of branching on agent ids.
 *
 * `explicitSessionResume` is deliberately false for every CLI-launched agent:
 * they resume "the most recent session" (`--continue`, `resume --last`,
 * `--resume`), which is not the exact session Kanban started for the task.
 * `automatedDelivery` requires both an input channel and an end-of-turn signal
 * Kanban can observe, so an agent without a hook integration stays false and
 * the operator performs delivery themselves.
 */
const RUNTIME_AGENT_CAPABILITIES: Record<RuntimeAgentId, RuntimeAgentCapabilities> = {
	claude: {
		terminalPresentation: true,
		explicitSessionResume: false,
		images: true,
		planMode: "cli-flag",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	codex: {
		terminalPresentation: true,
		explicitSessionResume: false,
		images: true,
		planMode: "prompt",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	cline: {
		terminalPresentation: true,
		explicitSessionResume: true,
		images: true,
		planMode: "cli-flag",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	opencode: {
		terminalPresentation: true,
		// AA-O1a: the pinned release accepts an exact session with `--session`,
		// so a resumed card names its own conversation instead of whichever
		// session OpenCode happened to touch last.
		explicitSessionResume: true,
		// Kanban launches the interactive TUI, and only the one-shot `run` form
		// has an attachment flag, so attachments are refused with a clear
		// message instead of being silently dropped.
		images: false,
		planMode: "cli-flag",
		// AA-O1a: `--auto` is this release's documented autonomous switch, so
		// autonomous mode no longer depends on answering every permission.
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	droid: {
		terminalPresentation: true,
		explicitSessionResume: false,
		images: true,
		planMode: "config-file",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	kiro: {
		terminalPresentation: true,
		explicitSessionResume: false,
		images: true,
		// Kiro has no planning switch: Kanban sends read-only instructions.
		planMode: "prompt",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	gemini: {
		terminalPresentation: true,
		explicitSessionResume: false,
		images: true,
		planMode: "cli-flag",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	pi: {
		terminalPresentation: true,
		// Pi is started with `--session-dir` and a Kanban-minted `--session-id`,
		// so a restart resumes the exact session Kanban created for the card.
		explicitSessionResume: true,
		images: true,
		// Pi has no planning switch and Kanban refuses the request rather than
		// pretending a normal Act run is a plan.
		planMode: "none",
		// Pi executes tool calls without an approval prompt, so there is no
		// switch to turn: the UI must not advertise an approval policy here.
		approvalMode: "none",
		completionSignal: "hook",
		automatedDelivery: true,
	},
};

/**
 * Where each agent's model/provider settings actually live. Cline is the only
 * agent Kanban configures itself; every other CLI owns its provider and model,
 * so Kanban must never present the Cline provider settings as their source.
 */
const RUNTIME_AGENT_MODEL_CONFIGURATION: Record<RuntimeAgentId, RuntimeAgentModelConfiguration> = {
	cline: {
		source: "kanban-settings",
		configLocations: ["Settings › Cline provider"],
		note: "Kanban selects the Cline provider, model and reasoning profile for this session.",
	},
	claude: {
		source: "agent-native",
		configLocations: ["~/.claude/settings.json"],
		note: "Claude Code selects its own provider and model; Kanban does not pass a model flag.",
	},
	codex: {
		source: "agent-native",
		configLocations: ["~/.codex/config.toml"],
		note: "Codex selects its own provider and model; Kanban does not pass a model flag.",
	},
	opencode: {
		source: "agent-native",
		configLocations: ["~/.config/opencode/opencode.json", "<project>/.opencode/opencode.json"],
		note:
			"OpenCode owns its providers. Kanban passes --model only from the model you selected in your own " +
			"OpenCode config (or KANBAN_OPENCODE_MODEL); it never reads OpenCode's auth store or prefers a " +
			"hosted provider.",
	},
	droid: {
		source: "agent-native",
		configLocations: [],
		note: "Factory Droid selects its own provider and model inside its CLI; Kanban does not pass a model flag.",
	},
	kiro: {
		source: "agent-native",
		configLocations: [],
		note: "Kiro selects its own provider and model inside its CLI; Kanban does not pass a model flag.",
	},
	gemini: {
		source: "agent-native",
		configLocations: ["~/.gemini/settings.json"],
		note: "Gemini CLI selects its own provider and model; Kanban does not pass a model flag.",
	},
	pi: {
		source: "agent-native",
		configLocations: ["~/.pi/agent/settings.json", "~/.pi/agent/models.json"],
		note: "Pi owns its provider and model in ~/.pi/agent (auth.json holds its credentials, which Kanban never reads) and runs tool calls without an approval prompt. Kanban only forwards Pi's own defaultProvider/defaultModel and never falls back to a hosted provider.",
	},
};

export function getRuntimeAgentCapabilities(agentId: RuntimeAgentId): RuntimeAgentCapabilities {
	return RUNTIME_AGENT_CAPABILITIES[agentId];
}

export function getRuntimeAgentModelConfiguration(agentId: RuntimeAgentId): RuntimeAgentModelConfiguration {
	return RUNTIME_AGENT_MODEL_CONFIGURATION[agentId];
}

/** Per-launch options that an agent may not support. */
export interface AgentLaunchRequestOptions {
	startInPlanMode?: boolean | undefined;
	imagesRequested?: boolean | undefined;
	autonomousModeRequested?: boolean | undefined;
}

function isRequested(value: boolean | undefined): boolean {
	return value === true;
}

/**
 * The requested options this agent cannot honor. An empty array means every
 * requested option is supported.
 */
export function getUnsupportedAgentLaunchOperations(
	agentId: RuntimeAgentId,
	options: AgentLaunchRequestOptions,
): RuntimeAgentLaunchOperation[] {
	const capabilities = getRuntimeAgentCapabilities(agentId);
	const unsupported: RuntimeAgentLaunchOperation[] = [];
	if (isRequested(options.startInPlanMode) && capabilities.planMode === "none") {
		unsupported.push("plan-mode");
	}
	if (isRequested(options.imagesRequested) && !capabilities.images) {
		unsupported.push("image-attachment");
	}
	if (isRequested(options.autonomousModeRequested) && capabilities.approvalMode === "none") {
		unsupported.push("autonomous-mode");
	}
	return unsupported;
}

const AGENT_LAUNCH_OPERATION_LABELS: Record<RuntimeAgentLaunchOperation, string> = {
	"plan-mode": "plan mode",
	"image-attachment": "image attachments",
	"autonomous-mode": "the bypass-permissions setting",
	"explicit-resume": "resuming the exact previous session",
};

export function describeAgentLaunchOperation(operation: RuntimeAgentLaunchOperation): string {
	return AGENT_LAUNCH_OPERATION_LABELS[operation];
}

/**
 * A user-facing error naming the agent and the options it cannot honor, or
 * null when everything requested is supported.
 */
export function formatUnsupportedAgentLaunchError(
	agentId: RuntimeAgentId,
	unsupported: readonly RuntimeAgentLaunchOperation[],
): string | null {
	if (unsupported.length === 0) {
		return null;
	}
	const entry = getRuntimeAgentCatalogEntry(agentId);
	const agentLabel = entry?.label ?? agentId;
	const operations = unsupported.map((operation) => describeAgentLaunchOperation(operation)).join(", ");
	return `${agentLabel} does not support ${operations}. Remove it from this task, or pick an agent that supports it.`;
}

/**
 * A user-facing error for a selected agent whose CLI is not installed. The
 * agent stays selectable in Settings for its install guidance only.
 */
export function formatMissingAgentInstallError(agentId: RuntimeAgentId): string {
	const entry = getRuntimeAgentCatalogEntry(agentId);
	const agentLabel = entry?.label ?? agentId;
	const installUrl = entry?.installUrl;
	return installUrl
		? `${agentLabel} is not installed (expected \`${entry?.binary ?? agentId}\` on PATH). Install it from ${installUrl}, then start the task again.`
		: `${agentLabel} is not installed (expected \`${entry?.binary ?? agentId}\` on PATH). Install its CLI, then start the task again.`;
}
