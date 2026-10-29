// Centralize direct SDK runtime imports here.
// All native Cline session-host creation and persisted artifact reads should
// flow through this boundary so the rest of Kanban stays decoupled from the
// SDK package layout.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type AgentEvent,
	type AgentHooks,
	type BasicLogger,
	buildWorkspaceMetadata,
	ClineCore,
	type ClineCoreStartInput,
	type CoreCompactionConfig,
	type CoreCompactionContext,
	type CoreCompactionResult,
	type CoreCompactionStrategy,
	type CoreCompactionSummarizerConfig,
	type CoreSessionEvent,
	createDefaultExecutors,
	createUserInstructionConfigService,
	formatRulesForSystemPrompt,
	getClineDefaultSystemPrompt,
	isRuleEnabled,
	type MessageWithMetadata,
	type RuleConfig,
	resolveClineDataDir,
	type SessionHistoryRecord,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type UserInstructionConfigService,
} from "@clinebot/core";
import { PR_CI_HANDOFF_GUIDANCE } from "../prompts/pr-ci-handoff";
import { CLINE_BUILTIN_SLASH_COMMANDS } from "./cline-slash-commands";
import { getCliTelemetryService } from "./cline-telemetry-service";

export { TelemetryLoggerSink, TelemetryService } from "@clinebot/core";
/** Use the SDK's filesystem semantics when adapting its hard-coded editor wrapper limit. */
export function createClineSdkEditorExecutor(): NonNullable<ReturnType<typeof createDefaultExecutors>["editor"]> {
	const editor = createDefaultExecutors().editor;
	if (!editor) throw new Error("SDK default editor executor unavailable");
	return editor;
}
/**
 * Mirrors DEFAULT_CONTEXT_WINDOW_TOKENS from @clinebot/core 0.0.38
 * (dist/extensions/context/compaction-shared.d.ts). The constant is not part
 * of the package's public exports, so it is mirrored here. Used as the
 * fallback cap when a provider does not report a context window (B-2-2), and
 * as the effective window passed into the explicit compaction config
 * (B-2-4).
 */
export const CLINE_SDK_DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;

let clineCorePackageVersion: string | null = null;

/**
 * Best-effort runtime version of the installed @clinebot/core package.
 *
 * The SDK does not export a version constant, and its exports map only
 * defines ESM conditions (no `require`/`default`), so require.resolve
 * cannot find the entry point either. Walk up from this boundary file and
 * look for the package in ancestor node_modules directories (works with
 * npm and pnpm hoisting). Falls back to "unknown" in packaged layouts
 * where the package cannot be located.
 */
export function getClineCorePackageVersion(): string {
	if (clineCorePackageVersion) {
		return clineCorePackageVersion;
	}
	try {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (;;) {
			const candidate = join(dir, "node_modules", "@clinebot", "core", "package.json");
			if (existsSync(candidate)) {
				const packageJson = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
				if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
					clineCorePackageVersion = packageJson.version;
					return packageJson.version;
				}
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) {
				break;
			}
			dir = parent;
		}
	} catch {
		// Best effort: diagnostics must never break session startup.
	}
	return "unknown";
}

export type ClineSdkSessionHost = ClineCore;
export type ClineSdkBasicLogger = BasicLogger;
export type ClineSdkAgentEvent = AgentEvent;

export type ClineSdkSessionEvent = CoreSessionEvent;

export type ClineSdkStartSessionInput = ClineCoreStartInput;
export type ClineSdkSessionRecord = SessionHistoryRecord;
export type ClineSdkPersistedMessage = MessageWithMetadata;
export type ClineSdkUserInstructionService = UserInstructionConfigService;
// B-2.4: Kanban passes an explicit compaction config on every session start.
// The `compact` callback is only set on the SDK's local runtime compaction
// object, never on start input, so Kanban builds Omit<..., "compact">.
export type ClineSdkCompactionConfig = CoreCompactionConfig;
export type ClineSdkCompactionStrategy = CoreCompactionStrategy;
export type ClineSdkCompactionSummarizerConfig = CoreCompactionSummarizerConfig;
// B-2.5: the SDK's compaction trigger hands the calibrated window, the trigger
// point, and the current messages to the host `compact` callback registered on
// localRuntime.compaction. These boundary aliases keep the callback decoupled
// from the SDK package layout like the other compaction types above.
export type ClineSdkCompactionContext = CoreCompactionContext;
export type ClineSdkCompactionResult = CoreCompactionResult;
// B-2.5: the agent-runtime beforeModel hook is the local-mode integration
// point for proactive compaction on @clinebot/core 0.0.38, where the SDK's
// own prepare-turn compaction pipeline is never invoked (upstream bug, see
// docs/plans/B-2-5.md). These types are derived from the SDK's AgentHooks so
// Kanban tracks the hook contract instead of redefining it.
export type ClineSdkAgentHooks = AgentHooks;
export type ClineSdkAgentBeforeModelHook = NonNullable<AgentHooks["beforeModel"]>;
export type ClineSdkAgentBeforeModelContext = Parameters<ClineSdkAgentBeforeModelHook>[0];
export type ClineSdkAgentBeforeModelResult = Exclude<Awaited<ReturnType<ClineSdkAgentBeforeModelHook>>, undefined>;

// B-2.6: the agent runtime (@clinebot/agents) also invokes `afterTool` after every tool
// execution; a returned `result` replaces the tool result before the `tool-result` message
// is persisted. Derived from the SDK's AgentHooks, like the beforeModel aliases above.
export type ClineSdkAgentAfterToolHook = NonNullable<AgentHooks["afterTool"]>;
export type ClineSdkAgentAfterToolContext = Parameters<ClineSdkAgentAfterToolHook>[0];
export type ClineSdkAgentAfterToolResult = Exclude<Awaited<ReturnType<ClineSdkAgentAfterToolHook>>, undefined>;
// The agent-runtime message shape (distinct from the persisted
// MessageWithMetadata shape): derived from the hook context so Kanban tracks
// the SDK's types instead of redefining them.
export type ClineSdkAgentMessage = ClineSdkAgentBeforeModelContext["request"]["messages"][number];
export type ClineSdkAgentMessagePart = ClineSdkAgentMessage["content"][number];
export interface ClineSdkSlashCommand {
	name: string;
	instructions: string;
	description?: string;
}
export type ClineSdkToolApprovalRequest = ToolApprovalRequest;
export type ClineSdkToolApprovalResult = ToolApprovalResult;

export async function createClineSdkSessionHost(): Promise<ClineSdkSessionHost> {
	return await ClineCore.create({
		backendMode: "auto",
		telemetry: getCliTelemetryService(),
	});
}

export function resolveClineSdkDataDir(): string {
	return resolveClineDataDir();
}
/** B-2.5: exposed so compaction calibration can estimate the SDK's default system prompt. */
export { getClineDefaultSystemPrompt };
export async function buildClineSdkWorkspaceMetadata(cwd: string): Promise<string> {
	return await buildWorkspaceMetadata(cwd);
}

export function createClineSdkUserInstructionService(workspacePath: string): ClineSdkUserInstructionService {
	return createUserInstructionConfigService({
		skills: { workspacePath },
		rules: { workspacePath },
		workflows: { workspacePath },
	});
}

export function listClineSdkWorkflowSlashCommands(service?: ClineSdkUserInstructionService): ClineSdkSlashCommand[] {
	const builtIns: ClineSdkSlashCommand[] = CLINE_BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		instructions: "",
		description: command.description,
	}));
	if (!service) {
		return builtIns;
	}
	const byName = new Map<string, ClineSdkSlashCommand>();
	for (const command of builtIns) {
		byName.set(command.name, command);
	}
	for (const command of service.listRuntimeCommands()) {
		if (byName.has(command.name)) {
			continue;
		}
		byName.set(command.name, {
			name: command.name,
			instructions: command.instructions,
			description: command.kind === "workflow" ? "Workflow command" : "Skill command",
		});
	}
	return [...byName.values()];
}

export function resolveClineSdkWorkflowSlashCommand(prompt: string, service: ClineSdkUserInstructionService): string {
	return service.resolveRuntimeSlashCommand(prompt);
}

export function loadClineSdkRulesForSystemPrompt(service: ClineSdkUserInstructionService): string {
	const rules = service
		.listRecords<RuleConfig>("rule")
		.map((record) => record.item)
		.filter(isRuleEnabled)
		.sort((left, right) => left.name.localeCompare(right.name));
	return formatRulesForSystemPrompt(rules);
}

/**
 * Local-mode editor adapter raises the SDK wrapper's 6000-character cap to 32000.
 * Keep guidance comfortably below that cap because models undercount characters.
 */
export const CLINE_EDITOR_SIZE_GUIDANCE = [
	"Editor tool usage and limits:",
	"- To replace text in an existing file, include `path`, `old_text`, and `new_text` in the actual editor tool arguments. `old_text` must be the exact existing text to replace and match exactly once; read the file first if needed.",
	"- Mentioning `old_text` in reasoning or prose does not supply it to the tool. Before sending an editor call, verify that its JSON arguments contain `old_text` for a replacement edit.",
	"- Omit `old_text` only when creating a file that does not exist, or when inserting text using `insert_line`. `path` plus `new_text` alone cannot edit an existing file.",
	"- If the tool reports missing `old_text`, rebuild the arguments with an explicit `old_text` string, or use `insert_line` for an intended insertion. Do not repeat the same incomplete call or assume the tool removed a parameter; JSON property order does not matter.",
	"- In local Kanban sessions, keep `new_text` and `old_text` under 30000 characters each; the hard limit is 32000. Split larger additions into sequential edits or a separate file.",
	"- After a replacement mismatch, read the current file section and copy a fresh unique anchor before retrying. Never repeat unchanged arguments that failed to match.",
	"- Prefer a new, separate file for large additions instead of growing an already large file.",
].join("\n");

/**
 * AR-4: planning and execution guidance for native coding sessions. Kept as
 * one named constant, separate from the editor recovery guidance above and
 * from the review/rollback role prompts. It is guidance about repeated
 * communication and execution, not a cap on internal reasoning: no
 * word/token/turn limits, no first-edit deadline, no forced one-plan rule,
 * and no ban on rereads.
 */
export const CLINE_PROPORTIONAL_PLANNING_GUIDANCE = [
	"Planning and execution:",
	"Gather enough context to understand the requirements, relevant code, risks, and verification before editing. State an implementation plan proportional to the task. Expand the plan when complexity or uncertainty warrants it, including design decisions and experiments needed for correctness.",
	"",
	"Once the plan is sufficient, proceed with implementation and verification. Revisit it when new evidence changes the approach, requirements, or risk. Avoid restating an unchanged plan; use brief progress updates to explain what changed and what comes next. Follow explicit user requests for planning, and preserve all required checks and review steps.",
].join("\n");

/**
 * AR-5: safe publication guidance for native coding sessions. Kept as one
 * named constant at the composer, separate from the planning and editor
 * guidance above and from the review/rollback role prompts. It does not
 * authorize publication, broaden a feedback snapshot, or require checking
 * for fresh comments during an implementation loop; it standardizes how
 * authorized Markdown publications preserve their bytes (the working
 * Auto-PR `--body-file` instruction is the source of truth).
 */
export const CLINE_PUBLICATION_GUIDANCE = [
	"When publication is authorized, preserve the exact intended Markdown. If using gh CLI for a multiline PR description or comment, write the body as UTF-8 to a file and use the command's supported --body-file option. For an API operation, use its supported structured input or file input. Keep backticks, dollar signs, quotes, and real newlines out of shell-interpolated body arguments. Keep temporary body files out of commits.",
	"",
	"Verify the stored body once after publication, and retain the identity/output required by the current workflow. If publication times out or its identity is unclear, inspect the existing remote state before creating another object. Follow the current bounded feedback instructions when choosing which comments to address.",
	"",
	PR_CI_HANDOFF_GUIDANCE,
].join("\n");

/**
 * The planning paragraph verbatim as shipped in the @clinebot/core 0.0.38
 * default system prompt (inspected in the installed package's generated
 * output). Its last sentence ("It's OK for this section to be quite long")
 * directly conflicts with the proportionate planning guidance above.
 */
const SDK_VERBOSE_INITIAL_PLAN_PARAGRAPH =
	"Begin by analyzing the user's input and gathering any necessary additional context. Then, present your plan at the start of your response along with tool calls before proceeding with the task. It's OK for this section to be quite long.";

export type ProportionalPlanningGuidanceStatus = "replaced" | "already-present" | "appended";

export interface ApplyProportionalPlanningGuidanceResult {
	prompt: string;
	/**
	 * "replaced": the SDK's verbose planning paragraph above was found exactly
	 * once and swapped in place for the guidance. "already-present": the
	 * guidance is already in the prompt, so it is returned unchanged (guards
	 * duplicate application). "appended": compatibility drift — the upstream
	 * paragraph changed, so the upstream prompt is preserved intact and the
	 * guidance is appended exactly once.
	 */
	status: ProportionalPlanningGuidanceStatus;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * AR-4: applies the proportionate planning guidance to the SDK's default
 * system prompt at the narrow composition point. It never removes any other
 * SDK section (reasoning, verification, approval, or safety); it either
 * replaces the single verbose planning paragraph in place or, if that
 * upstream wording drifts, appends the guidance once and surfaces the
 * discrepancy through the returned status.
 */
export function applyProportionalPlanningGuidance(defaultPrompt: string): ApplyProportionalPlanningGuidanceResult {
	if (defaultPrompt.includes(CLINE_PROPORTIONAL_PLANNING_GUIDANCE)) {
		return { prompt: defaultPrompt, status: "already-present" };
	}
	if (countOccurrences(defaultPrompt, SDK_VERBOSE_INITIAL_PLAN_PARAGRAPH) === 1) {
		return {
			prompt: defaultPrompt.replace(SDK_VERBOSE_INITIAL_PLAN_PARAGRAPH, CLINE_PROPORTIONAL_PLANNING_GUIDANCE),
			status: "replaced",
		};
	}
	return { prompt: `${defaultPrompt}\n\n${CLINE_PROPORTIONAL_PLANNING_GUIDANCE}`, status: "appended" };
}

export async function resolveClineSdkSystemPrompt(input: {
	cwd: string;
	providerId: string;
	rules?: string;
	/**
	 * AR-5: append the safe publication guidance. Set only for
	 * publication-capable native coding sessions; sidebar-only (home agent)
	 * and bounded review sessions compose without it.
	 */
	includePublicationGuidance: boolean;
}): Promise<string> {
	// The Cline SDK can run against non-Cline providers too, but only the
	// "cline" provider expects the extra workspace metadata block that powers
	// its repo-aware behavior in the same way the official CLI does.
	const shouldAppendWorkspaceMetadata = input.providerId === "cline";
	const workspaceMetadata = shouldAppendWorkspaceMetadata ? await buildWorkspaceMetadata(input.cwd) : "";
	const defaultPrompt = getClineDefaultSystemPrompt({
		ide: "Kanban",
		rootPath: input.cwd,
		providerId: input.providerId,
		metadata: workspaceMetadata,
		rules: input.rules ?? "",
	});
	// AR-4: swap the SDK's verbose initial planning paragraph for the proportionate
	// planning guidance. Only that one upstream paragraph is touched; every other
	// section of the SDK prompt is preserved verbatim.
	const { prompt: composedPrompt } = applyProportionalPlanningGuidance(defaultPrompt);
	const sections = [composedPrompt, CLINE_EDITOR_SIZE_GUIDANCE];
	// AR-5: the publication guidance is a separate final section for
	// publication-capable coding sessions only.
	if (input.includePublicationGuidance) {
		sections.push(CLINE_PUBLICATION_GUIDANCE);
	}
	return sections.join("\n\n");
}
