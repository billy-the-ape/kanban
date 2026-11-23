import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "auto"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		// AA-O1a: `--auto` is the documented autonomous switch in the pinned
		// release (1.19.6), so autonomous mode does not depend on answering
		// every permission prompt.
		autonomousArgs: ["--auto"],
		installUrl: "https://opencode.ai/docs/",
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
	},
	{
		// AA-P1: Pi runs tool calls without an approval prompt, so there is no
		// bypass flag to add; the autonomous toggle maps to no arguments.
		id: "pi",
		label: "Pi",
		binary: "pi",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent#installation",
	},
];

// Launch support is opt-in per CLI: an entry stays commented out until its
// adapter, capability row and lifecycle tests describe the release Kanban
// actually launches. OpenCode joined in AA-O1 against 1.19.6; Gemini stays off.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"claude",
	"codex",
	"droid",
	"kiro",
	"opencode",
	// AA-P1: launched with an exact Pi session plus a task-scoped extension.
	"pi",
	// "gemini",
];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}
