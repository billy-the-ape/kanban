// Centralize direct SDK runtime imports here.
// All native Cline session-host creation and persisted artifact reads should
// flow through this boundary so the rest of Kanban stays decoupled from the
// SDK package layout.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type AgentEvent,
	type BasicLogger,
	buildWorkspaceMetadata,
	ClineCore,
	type ClineCoreStartInput,
	type CoreCompactionConfig,
	type CoreCompactionStrategy,
	type CoreCompactionSummarizerConfig,
	type CoreSessionEvent,
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
import { CLINE_BUILTIN_SLASH_COMMANDS } from "./cline-slash-commands";
import { getCliTelemetryService } from "./cline-telemetry-service";

export { TelemetryLoggerSink, TelemetryService } from "@clinebot/core";
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

export async function resolveClineSdkSystemPrompt(input: {
	cwd: string;
	providerId: string;
	rules?: string;
}): Promise<string> {
	// The Cline SDK can run against non-Cline providers too, but only the
	// "cline" provider expects the extra workspace metadata block that powers
	// its repo-aware behavior in the same way the official CLI does.
	const shouldAppendWorkspaceMetadata = input.providerId === "cline";
	const workspaceMetadata = shouldAppendWorkspaceMetadata ? await buildWorkspaceMetadata(input.cwd) : "";
	return getClineDefaultSystemPrompt({
		ide: "Kanban",
		rootPath: input.cwd,
		providerId: input.providerId,
		metadata: workspaceMetadata,
		rules: input.rules ?? "",
	});
}
