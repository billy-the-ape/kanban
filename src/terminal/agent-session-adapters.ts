import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { quoteShellArg } from "../core/shell";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import {
	buildHooksCommandParts,
	createScopedHookResources,
	ensureTextFile,
	getScopedHookAgentDirectory,
	hasCliOption,
	resolveHookContext,
	toResourceScopeSegment,
	withPrompt,
} from "./agent-launch-helpers";
import { configureCodexHooks, hasCodexConfigOverride } from "./codex-hook-config";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import {
	buildOpenCodeOverlayConfigContent,
	buildOpenCodePluginManifestContent,
	describeOpenCodeCompatibility,
	formatOpenCodeVersion,
	getOpenCodeOverlayLayout,
	isOpenCodeSessionSelector,
	KANBAN_OPENCODE_SESSION_ID_ENV,
	probeOpenCodeVersion,
	readOpenCodeUserConfig,
	resolveOpenCodeModelSelection,
	verifyOpenCodeSession,
} from "./opencode-integration";
import { buildOpenCodePluginSource } from "./opencode-plugin-source";
import { stripAnsi } from "./output-utils";
import { piAdapter } from "./pi-session-adapter";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	/**
	 * AA-S1: token for this launch attempt, minted by the session manager. It
	 * scopes generated integration resources and is echoed back through the
	 * hook environment so events from a superseded attempt can be rejected.
	 */
	attemptId?: string;
	/**
	 * AA-O1a: the external session id Kanban recorded for this card from the
	 * agent's own events. A resume-intent launch must name this session instead
	 * of relying on the CLI's "most recent session" behaviour; adapters that
	 * cannot resume exactly what they are given say so with `explicitSessionResume`.
	 */
	externalSessionId?: string | null;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
	/**
	 * A request the adapter could not fully honor, surfaced on the session
	 * summary instead of being dropped in silence.
	 */
	warningMessage?: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

export interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function powerShellQuote(value: string): string {
	return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

function getClineHookScriptPath(
	hooksDir: string,
	hookName: "Notification" | "TaskComplete" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse",
): string {
	if (process.platform === "win32") {
		return join(hooksDir, `${hookName}.ps1`);
	}
	return join(hooksDir, hookName);
}

function buildClineHookScriptContent(event: RuntimeHookEvent): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", event, "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
try {
  $inputText | & ${command} | Out-Null
} catch {
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
echo '{"cancel":false}'
`;
}

function buildClineNotificationHookScriptContent(): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
if (
  $inputText -match '"event"\\s*:\\s*"user_attention"' -and
  $inputText -notmatch '"source"\\s*:\\s*"completion_result"'
) {
  try {
    $inputText | & ${command} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
if printf '%s' "$INPUT" | grep -Eq '"event"[[:space:]]*:[[:space:]]*"user_attention"' &&
  ! printf '%s' "$INPUT" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"completion_result"'; then
  printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePreToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const reviewCommand = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const review = reviewCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${review} | Out-Null
  } catch {
  }
} else {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const review = reviewCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${review} >/dev/null 2>&1 || true
else
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePostToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

/**
 * Kiro keeps its agent definitions in a directory Kiro owns, so its generated
 * file cannot live in the per-attempt directory and is removed individually.
 * The path is re-checked against that directory before anything is deleted.
 */
function createKiroAgentFileCleanup(configPath: string): () => Promise<void> {
	return async () => {
		const kiroAgentsDir = join(homedir(), ".kiro", "agents");
		const relativePath = relative(kiroAgentsDir, configPath);
		if (
			!relativePath ||
			relativePath.startsWith("..") ||
			isAbsolute(relativePath) ||
			!relativePath.endsWith(".json")
		) {
			return;
		}
		await rm(configPath, { force: true }).catch(() => {
			// Best effort: Kiro may keep the file for its own housekeeping.
		});
	};
}

/**
 * Kiro owns its agent-file directory, so Kanban's generated file cannot live
 * under the runtime home. It is still named per task, so two tasks on the same
 * machine no longer overwrite each other's `--agent` definition.
 */
function getKiroKanbanAgentName(taskId: string): string {
	return `kanban-${toResourceScopeSegment(taskId)}`;
}

function getKiroAgentConfigPath(taskId: string): string {
	return join(homedir(), ".kiro", "agents", `${getKiroKanbanAgentName(taskId)}.json`);
}

function toBracketedPasteSubmission(command: string): string {
	return `\u001b[200~${command}\u001b[201~\r`;
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (input.autonomousModeEnabled) {
			// Auto mode is gated behind this env var on Bedrock/Vertex/Foundry; the Anthropic API ignores it.
			env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
		}
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--permission-mode") &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--permission-mode", "auto");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			args.push("--permission-mode", "plan");
		}

		const hooks = resolveHookContext(input);
		const resources = hooks ? createScopedHookResources("claude", hooks) : null;
		if (hooks && resources) {
			const settingsPath = join(resources.directory, "settings.json");
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(env, createHookRuntimeEnv(hooks));
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			...(resources ? { cleanup: resources.cleanup } : {}),
		};
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupInput: string | undefined;
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(env, createHookRuntimeEnv(hooks));
		}

		const trimmed = input.prompt.trim();
		if (input.startInPlanMode) {
			const planCommand = trimmed ? `/plan ${trimmed}` : "/plan";
			deferredStartupInput = toBracketedPasteSubmission(planCommand);
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}

		if (hooks) {
			return {
				binary,
				args: codexArgs,
				env,
				deferredStartupInput,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume")) {
			args.push("--resume", "latest");
		}

		if (input.startInPlanMode) {
			args.push("--approval-mode=plan");
		}

		const hooks = resolveHookContext(input);
		const resources = hooks ? createScopedHookResources("gemini", hooks) : null;
		if (hooks && resources) {
			const configPath = join(resources.directory, "settings.json");
			const geminiHookCommand = buildHooksCommand(["gemini-hook"]);

			const config = {
				hooks: {
					BeforeTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					BeforeAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					Notification: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
				},
			};
			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			Object.assign(env, createHookRuntimeEnv(hooks));
			env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
		}

		const cleanup = resources ? { cleanup: resources.cleanup } : {};
		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
			return {
				args,
				env,
				...cleanup,
			};
		}

		return {
			args,
			env,
			...cleanup,
		};
	},
};

/** AA-O1a: Kanban drives the interactive TUI, so the command is the CLI itself. */
const OPENCODE_DEFAULT_BINARY = "opencode";

/**
 * AA-O1: OpenCode launch policy for the pinned release.
 *
 * The flags below are the ones `opencode --help` documents for 1.19.6:
 * `--session <id>` continues one exact session, `--agent plan` selects the
 * built-in read-only agent, `--auto` is the autonomous switch, and `--prompt`
 * seeds the first message. `--continue` is deliberately absent: it follows
 * whichever session OpenCode touched last, which is a different conversation
 * than this card owns as soon as two OpenCode tasks run in the same project.
 */
const opencodeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary?.trim() || OPENCODE_DEFAULT_BINARY;
		const warnings: string[] = [];

		// Refuse an unsupported release before any session exists, so no card can
		// be launched on flags or a plugin contract this adapter does not
		// describe. An unreadable version stays allowed: install guidance beats
		// blocking a CLI whose only crime is printing an unexpected version line.
		const version = await probeOpenCodeVersion(binary, { cwd: input.cwd, env: input.env });
		const compatibility = describeOpenCodeCompatibility(formatOpenCodeVersion(version));
		if (compatibility.remediation) {
			throw new Error(compatibility.remediation);
		}

		// AA-O1a: a resumed card names the session Kanban recorded from the
		// agent's own events. Without that id there is nothing safe to resume, so
		// the launch fails with the alternative instead of guessing.
		const externalSessionId = input.externalSessionId?.trim() ?? "";
		if (input.resumeFromTrash) {
			if (!isOpenCodeSessionSelector(externalSessionId)) {
				throw new Error(
					`OpenCode cannot resume this card: Kanban has no OpenCode session id stored for it, and continuing the most recent session could attach the card to another task's conversation. Start a new OpenCode session for this card instead${compatibility.version ? ` (OpenCode ${formatOpenCodeVersion(compatibility.version)})` : ""}.`,
				);
			}
			const sessionExists = await verifyOpenCodeSession(externalSessionId, {
				binary,
				cwd: input.cwd,
				env: input.env,
			});
			if (sessionExists === false) {
				throw new Error(
					`OpenCode session ${externalSessionId} is not available in this workspace, so Kanban will not continue an unrelated session in its place. Start a new OpenCode session for this card.`,
				);
			}
			args.push("--session", externalSessionId);
		}
		if (hasCliOption(args, "--continue")) {
			// A command saved before AA-O1 can still carry `--continue`. Drop it on
			// every path: "most recent session" is not a per-card fact, and on a
			// resume it would sit next to the `--session` this launch just pinned,
			// leaving the CLI to decide which one wins.
			const withoutContinue = args.filter((arg) => arg !== "--continue");
			args.length = 0;
			args.push(...withoutContinue);
			warnings.push(
				"Removed OpenCode's --continue flag from this launch: it follows the most recent session, which is not this card's session. Kanban resumes the recorded session id instead.",
			);
		}

		if (input.startInPlanMode && !hasCliOption(args, "--agent")) {
			// `plan` is a primary agent in this release, so the read-only start is
			// one documented flag and no experimental configuration.
			args.push("--agent", "plan");
		}
		if (input.autonomousModeEnabled && !hasCliOption(args, "--auto")) {
			args.push("--auto");
		}

		const hooks = resolveHookContext(input);
		const resources = hooks ? createScopedHookResources("opencode", hooks) : null;
		if (hooks && resources) {
			const overlay = getOpenCodeOverlayLayout(resources.directory);
			// A user who exports `OPENCODE_CONFIG` points it at their own file, and
			// the pinned release reads that file instead of the ones Kanban would
			// otherwise add, so repointing the variable has to carry their
			// configuration into the overlay rather than replace it.
			const userConfigPath = input.env?.OPENCODE_CONFIG?.trim() || null;
			const userConfig = userConfigPath ? await readOpenCodeUserConfig(userConfigPath) : null;
			Object.assign(env, createHookRuntimeEnv(hooks));
			if (userConfigPath && !userConfig) {
				// Their configuration wins: Kanban leaves the variable alone instead of
				// discarding a file it cannot parse, and says the bridge is inactive so
				// a card that never moves is explained now rather than wondered about.
				warnings.push(
					`Kanban could not merge ${userConfigPath} (OPENCODE_CONFIG), so this launch runs without the Kanban bridge and the card will not move itself to review. Unset OPENCODE_CONFIG to let Kanban supply it.`,
				);
			} else {
				await ensureTextFile(
					overlay.entryPointPath,
					// `--source opencode` selects the OpenCode normalizer, which is what
					// reads the bridge's own payload keys. Without it the generic
					// parser would accept the call and drop the text it carries.
					buildOpenCodePluginSource({
						reviewArgv: buildHooksCommandParts(["ingest", "--event", "to_review", "--source", "opencode"]),
						inProgressArgv: buildHooksCommandParts([
							"ingest",
							"--event",
							"to_in_progress",
							"--source",
							"opencode",
						]),
						activityArgv: buildHooksCommandParts(["ingest", "--event", "activity", "--source", "opencode"]),
					}),
				);
				await ensureTextFile(overlay.manifestPath, buildOpenCodePluginManifestContent());
				await ensureTextFile(overlay.configPath, buildOpenCodeOverlayConfigContent(overlay, userConfig));
				// The pinned release merges OPENCODE_CONFIG as an additional source, so
				// the user's global and project configuration (providers, credentials,
				// agents, MCP servers, instructions) keeps loading unchanged; the
				// overlay only adds the bridge on top of it.
				env.OPENCODE_CONFIG = overlay.configPath;
			}
			// A task launch must never download a different OpenCode build behind
			// the version check that just passed.
			env.OPENCODE_DISABLE_AUTOUPDATE = "1";
			// A resume already failed above unless Kanban holds a valid id, so this
			// only has to ask whether this launch is that resume.
			if (input.resumeFromTrash) {
				// Only a real resume pins its root session: OpenCode starts a fresh
				// conversation with a new id, and a bridge pinned to the id from the
				// previous conversation would reject every event from the running one.
				// Without a pin the bridge adopts the new session and reports its id,
				// so another task's activity can still never move this card.
				env[KANBAN_OPENCODE_SESSION_ID_ENV] = externalSessionId;
			}
		}

		if (!hasCliOption(args, "--model") && !hasCliOption(args, "-m")) {
			// AA-O1a: only an explicit selection is passed. That is the model the
			// user selected in their own OpenCode configuration (or
			// KANBAN_OPENCODE_MODEL); Kanban never derives one from a credential
			// store or prefers a hosted provider. Without a selection OpenCode
			// applies its own default, and a bad selector fails loudly in the CLI
			// rather than silently switching provider.
			const selection = await resolveOpenCodeModelSelection({ cwd: input.cwd, env: input.env });
			if (selection.model) {
				args.push("--model", selection.model);
			}
			if (selection.warning) {
				warnings.push(selection.warning);
			}
		}

		const trimmed = input.prompt.trim();
		if (trimmed) {
			// One argv element, so a multi-line or unicode prompt cannot be
			// re-split by a shell. Kanban keeps the TUI rather than
			// `run --format json` because the card must accept follow-up input.
			args.push("--prompt", trimmed);
		}

		return {
			args,
			env,
			...(warnings.length > 0 ? { warningMessage: warnings.join(" ") } : {}),
			...(resources ? { cleanup: resources.cleanup } : {}),
		};
	},
};

const droidAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const resources = hooks ? createScopedHookResources("droid", hooks) : null;
		const shouldWriteSettings = Boolean(hooks) || input.startInPlanMode || input.autonomousModeEnabled !== undefined;
		if (shouldWriteSettings) {
			// Without a workspace there is no attempt to scope, so this stays the
			// shared home-agent settings file it always was.
			const settingsPath = join(getScopedHookAgentDirectory("droid", hooks), "settings.json");
			const settings: Record<string, unknown> = {
				autonomyMode: input.startInPlanMode ? "spec" : input.autonomousModeEnabled ? "auto-high" : "normal",
			};

			if (hooks) {
				const droidActiveToolMatcher = "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create";
				const reviewNotifyCommand = buildHooksCommand(["notify", "--event", "to_review", "--source", "droid"]);
				const inProgressNotifyCommand = buildHooksCommand([
					"notify",
					"--event",
					"to_in_progress",
					"--source",
					"droid",
				]);
				const activityNotifyCommand = buildHooksCommand(["notify", "--event", "activity", "--source", "droid"]);
				settings.hooks = {
					Stop: [{ hooks: [{ type: "command", command: reviewNotifyCommand }] }],
					Notification: [
						{ hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PreToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: droidActiveToolMatcher, hooks: [{ type: "command", command: inProgressNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PostToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: inProgressNotifyCommand }] },
					],
					PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] }],
					UserPromptSubmit: [{ hooks: [{ type: "command", command: inProgressNotifyCommand }] }],
				};

				Object.assign(env, createHookRuntimeEnv(hooks));
			}

			await ensureTextFile(settingsPath, JSON.stringify(settings, null, 2));
			if (!hasCliOption(args, "--settings")) {
				args.push("--settings", settingsPath);
			}
		}

		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			...(resources ? { cleanup: resources.cleanup } : {}),
		};
	},
};

const kiroAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--trust-all-tools")) {
			args.push("--trust-all-tools");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		// Kiro has no flag for a planning or autonomous mode (the read-only
		// behaviour below is instructed, not enforced), and its agent definitions live
		// in a directory Kiro owns. The generated file is still named per task so two
		// tasks cannot overwrite each other's `--agent` definition.
		const agentName = getKiroKanbanAgentName(input.taskId);
		const configPath = getKiroAgentConfigPath(input.taskId);
		const cleanup = hooks ? { cleanup: createKiroAgentFileCleanup(configPath) } : {};
		if (hooks || appendedSystemPrompt) {
			const config: Record<string, unknown> = {
				name: agentName,
				description: "Kanban-managed Kiro agent with hook forwarding.",
				tools: ["*"],
			};

			if (hooks) {
				config.hooks = {
					agentSpawn: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "agentSpawn",
							}),
						},
					],
					userPromptSubmit: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "userPromptSubmit",
							}),
						},
					],
					preToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
					],
					postToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "postToolUse",
							}),
						},
					],
					stop: [
						{
							command: buildHookCommand("to_review", {
								source: "kiro",
								hookEventName: "stop",
								activityText: "Waiting for review",
							}),
						},
					],
				};
				Object.assign(env, createHookRuntimeEnv(hooks));
			}

			if (appendedSystemPrompt) {
				config.prompt = appendedSystemPrompt;
			}

			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			if (!hasCliOption(args, "--agent")) {
				args.push("--agent", agentName);
			}
		}

		const trimmedPrompt = input.prompt.trim();
		const planPrompt = input.startInPlanMode
			? [
					"First, inspect the codebase and produce a clear implementation plan only.",
					"Do not modify files, do not use write tools, and do not implement anything yet.",
					"After you present the plan, ask for approval before making changes.",
					trimmedPrompt
						? `\n\nTask:\n${trimmedPrompt}`
						: " Ask the user what they want planned if the task is unclear.",
				].join(" ")
			: input.prompt;
		const withPromptLaunch = withPrompt(args, planPrompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			...cleanup,
		};
	},
};

const clineAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--auto-approve-all")) {
			args.push("--auto-approve-all");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			args.push("--plan");
		}

		const hooks = resolveHookContext(input);
		const resources = hooks ? createScopedHookResources("cline", hooks) : null;
		if (hooks && resources) {
			const hooksDir = resources.directory;
			const notificationHookPath = getClineHookScriptPath(hooksDir, "Notification");
			const taskCompleteHookPath = getClineHookScriptPath(hooksDir, "TaskComplete");
			const userPromptSubmitHookPath = getClineHookScriptPath(hooksDir, "UserPromptSubmit");
			const preToolUseHookPath = getClineHookScriptPath(hooksDir, "PreToolUse");
			const postToolUseHookPath = getClineHookScriptPath(hooksDir, "PostToolUse");
			const executable = process.platform !== "win32";

			await ensureTextFile(notificationHookPath, buildClineNotificationHookScriptContent(), executable);
			await ensureTextFile(taskCompleteHookPath, buildClineHookScriptContent("to_review"), executable);
			await ensureTextFile(userPromptSubmitHookPath, buildClineHookScriptContent("to_in_progress"), executable);
			await ensureTextFile(preToolUseHookPath, buildClinePreToolUseHookScriptContent(), executable);
			await ensureTextFile(postToolUseHookPath, buildClinePostToolUseHookScriptContent(), executable);

			if (!hasCliOption(args, "--hooks-dir")) {
				args.push("--hooks-dir", hooksDir);
			}

			Object.assign(env, createHookRuntimeEnv(hooks));
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			...(resources ? { cleanup: resources.cleanup } : {}),
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	gemini: geminiAdapter,
	opencode: opencodeAdapter,
	droid: droidAdapter,
	kiro: kiroAdapter,
	pi: piAdapter,
	cline: clineAdapter,
};

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	return await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
	});
}
