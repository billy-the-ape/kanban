import type { RuntimeAgentDefinition } from "@/runtime/types";

/**
 * AA-S1 added capability, model-configuration and install fields to every agent
 * definition the runtime returns. Test fixtures that only exercise the
 * pre-AA-S1 fields (which agent is installed, which one is selected) spread
 * these defaults instead of repeating the whole capability table.
 */
export const agentDefinitionTestDefaults: Pick<
	RuntimeAgentDefinition,
	"capabilities" | "modelConfiguration" | "installUrl"
> = {
	capabilities: {
		terminalPresentation: true,
		explicitSessionResume: false,
		images: true,
		planMode: "cli-flag",
		approvalMode: "cli-flag",
		completionSignal: "hook",
		automatedDelivery: true,
	},
	modelConfiguration: {
		source: "kanban-settings",
		configLocations: [],
		note: "Model comes from Kanban's Cline provider settings.",
	},
	installUrl: "https://example.com/install-agent",
};
