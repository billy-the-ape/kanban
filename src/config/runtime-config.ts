// Persists Kanban-owned runtime preferences on disk.
// This module should store Kanban settings such as selected agents,
// shortcuts, and prompt templates, not SDK-owned Cline secrets or OAuth data.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeContextBudget,
	RuntimeContextBudgetSave,
	RuntimeProjectShortcut,
	RuntimeReviewPolicy,
	RuntimeReviewPolicySave,
	RuntimeVerificationConfig,
	RuntimeVerificationConfigSave,
} from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { detectInstalledCommands } from "../terminal/agent-registry";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils";

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	contextBudget?: RuntimeContextBudget;
	reviewPolicy?: RuntimeReviewPolicySave;
	verification?: RuntimeVerificationConfigSave;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
	/** B-2.9: global context budget settings; absent means all defaults. */
	contextBudget?: RuntimeContextBudget;
	/** B-6: global review lifecycle policy; absent means all defaults (off, 2 repair rounds). */
	reviewPolicy?: RuntimeReviewPolicy;
	/** B-7: global verification gate; absent means the gate is inactive (off, no checks). */
	verification?: RuntimeVerificationConfig;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	/** B-2.9: `null` clears all context budget settings; `undefined` leaves them untouched. */
	contextBudget?: RuntimeContextBudgetSave | null;
	/** B-6: `null` clears all review policy settings; `undefined` leaves them untouched. */
	reviewPolicy?: RuntimeReviewPolicySave | null;
	/** B-7: `null` clears all verification gate settings; `undefined` leaves them untouched. */
	verification?: RuntimeVerificationConfigSave | null;
}

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PARENT_DIR = ".cline";
const PROJECT_CONFIG_DIR = "kanban";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "cline";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex", "droid", "kiro"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = true;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_REVIEW_POLICY_ENABLED: "required" | "off" = "off";
const DEFAULT_REVIEW_POLICY_MAX_REPAIR_ROUNDS = 2;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P. If this fails because .git/index.lock exists, wait briefly for any active git process to finish. If the lock remains and no git process is active, treat the lock as stale, remove it, and retry.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If step 4 created a new stash entry, restore that stash with: git -C P stash pop <stash-ref>
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
		const binary = catalogEntry?.binary ?? agentId;
		if (detected.has(binary) || detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if (
		(agentId === "claude" ||
			agentId === "codex" ||
			agentId === "gemini" ||
			agentId === "opencode" ||
			agentId === "droid" ||
			agentId === "kiro" ||
			agentId === "cline") &&
		isRuntimeAgentLaunchSupported(agentId)
	) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeContextBudgetTokenField(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return undefined;
	}
	return value;
}

function normalizeContextBudgetRatio(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		return undefined;
	}
	return value;
}

function normalizeContextBudgetStrategy(value: unknown): "basic" | "agentic" | undefined {
	if (value === "basic" || value === "agentic") {
		return value;
	}
	return undefined;
}

/** B-2.9: drop invalid/empty fields so corrupted config files degrade to defaults instead of failing to load. */
function normalizeContextBudget(value: unknown): RuntimeContextBudget | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const budget: RuntimeContextBudget = {};
	const contextWindowOverrideTokens = normalizeContextBudgetTokenField(raw.contextWindowOverrideTokens);
	if (contextWindowOverrideTokens !== undefined) {
		budget.contextWindowOverrideTokens = contextWindowOverrideTokens;
	}
	const compactionStrategy = normalizeContextBudgetStrategy(raw.compactionStrategy);
	if (compactionStrategy !== undefined) {
		budget.compactionStrategy = compactionStrategy;
	}
	const triggerThresholdRatio = normalizeContextBudgetRatio(raw.triggerThresholdRatio);
	if (triggerThresholdRatio !== undefined) {
		budget.triggerThresholdRatio = triggerThresholdRatio;
	}
	const outputReserveTokens = normalizeContextBudgetTokenField(raw.outputReserveTokens);
	if (outputReserveTokens !== undefined) {
		budget.outputReserveTokens = outputReserveTokens;
	}
	const safetyMarginTokens = normalizeContextBudgetTokenField(raw.safetyMarginTokens);
	if (safetyMarginTokens !== undefined) {
		budget.safetyMarginTokens = safetyMarginTokens;
	}
	return Object.keys(budget).length > 0 ? budget : undefined;
}

const CONTEXT_BUDGET_TOKEN_FIELDS = [
	["contextWindowOverrideTokens", "contextWindowOverrideTokens"] as const,
	["outputReserveTokens", "outputReserveTokens"] as const,
	["safetyMarginTokens", "safetyMarginTokens"] as const,
];

/**
 * B-2.9: strict validation for save-time input (the API boundary already
 * validates via zod; this is defense in depth for direct callers). `null`
 * clears a field (resets it to the default), so null is valid for every
 * field.
 */
function validateContextBudget(budget: RuntimeContextBudgetSave | null | undefined): void {
	if (budget === null || budget === undefined) {
		return;
	}
	for (const [key, label] of CONTEXT_BUDGET_TOKEN_FIELDS) {
		const value = budget[key];
		if (value !== null && value !== undefined && (!Number.isInteger(value) || value <= 0)) {
			throw new Error(`${label} must be a positive integer token count.`);
		}
	}
	if (
		budget.compactionStrategy !== null &&
		budget.compactionStrategy !== undefined &&
		budget.compactionStrategy !== "basic" &&
		budget.compactionStrategy !== "agentic"
	) {
		throw new Error("compactionStrategy must be either 'basic' or 'agentic'.");
	}
	if (
		budget.triggerThresholdRatio !== null &&
		budget.triggerThresholdRatio !== undefined &&
		(budget.triggerThresholdRatio <= 0 || budget.triggerThresholdRatio > 1)
	) {
		throw new Error("triggerThresholdRatio must be a number between 0 and 1 (exclusive of 0).");
	}
}

// Accepts the save shape (nullable fields): null and undefined both mean
// "unset" for comparison purposes.
function areRuntimeContextBudgetsEqual(
	left: RuntimeContextBudgetSave | null | undefined,
	right: RuntimeContextBudgetSave | null | undefined,
): boolean {
	if (!left && !right) {
		return true;
	}
	if (!left || !right) {
		return false;
	}
	return (
		(left.contextWindowOverrideTokens ?? null) === (right.contextWindowOverrideTokens ?? null) &&
		(left.compactionStrategy ?? null) === (right.compactionStrategy ?? null) &&
		(left.triggerThresholdRatio ?? null) === (right.triggerThresholdRatio ?? null) &&
		(left.outputReserveTokens ?? null) === (right.outputReserveTokens ?? null) &&
		(left.safetyMarginTokens ?? null) === (right.safetyMarginTokens ?? null)
	);
}

/**
 * B-2.9: merges a save-shape context budget update against the stored budget
 * so per-field nulls (clear-to-default) survive normalization: an undefined
 * update leaves the stored budget untouched, a null clears everything, and an
 * object update applies each field — null clears that field, a value sets it.
 */
function mergeContextBudgetUpdates(
	stored: RuntimeContextBudget | undefined,
	updates: RuntimeContextBudgetSave | null | undefined,
): RuntimeContextBudgetSave | null | undefined {
	if (updates === undefined) {
		return undefined;
	}
	if (updates === null) {
		return null;
	}
	return { ...(stored ?? {}), ...updates };
}

/** B-6: drop invalid/empty fields so corrupted config files degrade to defaults. */
function normalizeReviewPolicyValue(
	value: unknown,
	field: keyof RuntimeReviewPolicy,
): RuntimeReviewPolicy[keyof RuntimeReviewPolicy] | undefined {
	if (field === "enabled") {
		return value === "required" || value === "off" ? value : undefined;
	}
	if (field === "instructions") {
		return typeof value === "string" ? value : undefined;
	}
	if (field === "modelOverride") {
		if (value === null) {
			return null;
		}
		if (value && typeof value === "object") {
			const candidate = value as { providerId?: unknown; modelId?: unknown };
			if (typeof candidate.providerId === "string" && candidate.providerId.trim()) {
				if (typeof candidate.modelId === "string" && candidate.modelId.trim()) {
					return { providerId: candidate.providerId, modelId: candidate.modelId };
				}
			}
			return undefined;
		}
		return undefined;
	}
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10) {
		return value;
	}
	return undefined;
}

/** B-6: normalize a stored/partial review policy; undefined means all defaults. */
function normalizeReviewPolicy(value: unknown): RuntimeReviewPolicy | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const policy: RuntimeReviewPolicy = {
		enabled:
			(normalizeReviewPolicyValue(raw.enabled, "enabled") as "required" | "off") ?? DEFAULT_REVIEW_POLICY_ENABLED,
		instructions: (normalizeReviewPolicyValue(raw.instructions, "instructions") as string | undefined) ?? "",
		modelOverride:
			(normalizeReviewPolicyValue(raw.modelOverride, "modelOverride") as RuntimeReviewPolicy["modelOverride"]) ??
			null,
		maxRepairRounds:
			(normalizeReviewPolicyValue(raw.maxRepairRounds, "maxRepairRounds") as number) ??
			DEFAULT_REVIEW_POLICY_MAX_REPAIR_ROUNDS,
	};
	return policy;
}

/**
 * B-6: strict validation for save-time input (the API boundary already
 * validates via zod; this is defense in depth for direct callers).
 */
function validateReviewPolicy(policy: RuntimeReviewPolicySave | null | undefined): void {
	if (policy === null || policy === undefined) {
		return;
	}
	if (policy.enabled !== undefined && policy.enabled !== "required" && policy.enabled !== "off") {
		throw new Error("reviewPolicy.enabled must be either 'required' or 'off'.");
	}
	if (
		policy.maxRepairRounds !== undefined &&
		(!Number.isInteger(policy.maxRepairRounds) || policy.maxRepairRounds < 1 || policy.maxRepairRounds > 10)
	) {
		throw new Error("reviewPolicy.maxRepairRounds must be an integer between 1 and 10.");
	}
}

/** B-6: merges a save-shape review policy update (null clears everything, undefined leaves it untouched). */
function mergeReviewPolicyUpdates(
	stored: RuntimeReviewPolicy | undefined,
	updates: RuntimeReviewPolicySave | null | undefined,
): RuntimeReviewPolicySave | null | undefined {
	if (updates === undefined) {
		return undefined;
	}
	if (updates === null) {
		return null;
	}
	return { ...(stored ?? {}), ...updates };
}

function areRuntimeReviewPoliciesEqual(
	left: RuntimeReviewPolicySave | null | undefined,
	right: RuntimeReviewPolicySave | null | undefined,
): boolean {
	if (!left && !right) {
		return true;
	}
	if (!left || !right) {
		return false;
	}
	return (
		left.enabled === right.enabled &&
		left.instructions === right.instructions &&
		left.maxRepairRounds === right.maxRepairRounds &&
		(left.modelOverride?.providerId ?? null) === (right.modelOverride?.providerId ?? null) &&
		(left.modelOverride?.modelId ?? null) === (right.modelOverride?.modelId ?? null)
	);
}

const DEFAULT_VERIFICATION_ENABLED: "required" | "off" = "off";

/** B-7.1: a check working directory must stay inside the task worktree root. */
function isSafeVerificationCwd(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
		return false;
	}
	// Reject absolute Windows paths (C:\) and any segment that traverses upward.
	if (/^[a-zA-Z]:/.test(trimmed) || trimmed.split(/[\\/]+/).includes("..")) {
		return false;
	}
	return true;
}

/** B-7.1: normalize one stored check; malformed entries are dropped (load-time defense in depth). */
function normalizeVerificationCheck(value: unknown): RuntimeVerificationConfig["checks"][number] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	const command = typeof record.command === "string" ? record.command.trim() : "";
	if (!id || !command) {
		return undefined;
	}
	const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
	const cwd = typeof record.cwd === "string" && isSafeVerificationCwd(record.cwd) ? record.cwd.trim() : undefined;
	const timeoutMs =
		typeof record.timeoutMs === "number" && Number.isInteger(record.timeoutMs) && record.timeoutMs > 0
			? record.timeoutMs
			: undefined;
	const env =
		record.env && typeof record.env === "object" && !Array.isArray(record.env)
			? Object.fromEntries(
					Object.entries(record.env as Record<string, unknown>).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: undefined;
	const successExitCodes = Array.isArray(record.successExitCodes)
		? record.successExitCodes.filter(
				(code): code is number => typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255,
			)
		: [];
	return {
		id,
		command,
		args,
		...(cwd ? { cwd } : {}),
		...(timeoutMs ? { timeoutMs } : {}),
		...(env && Object.keys(env).length > 0 ? { env } : {}),
		successExitCodes: successExitCodes.length > 0 ? successExitCodes : [0],
		required: typeof record.required === "boolean" ? record.required : true,
	};
}

/** B-7.1: normalize a stored verification config; undefined means the gate is inactive. */
function normalizeVerificationConfig(value: unknown): RuntimeVerificationConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const enabled: "required" | "off" =
		record.enabled === "required" || record.enabled === "off" ? record.enabled : DEFAULT_VERIFICATION_ENABLED;
	const checks: RuntimeVerificationConfig["checks"] = [];
	const seenIds = new Set<string>();
	if (Array.isArray(record.checks)) {
		for (const item of record.checks) {
			const check = normalizeVerificationCheck(item);
			if (!check || seenIds.has(check.id.toLowerCase())) {
				continue;
			}
			seenIds.add(check.id.toLowerCase());
			checks.push(check);
		}
	}
	return { enabled, checks };
}

/**
 * B-7.1: strict save-time validation of the operator-managed verification config
 * (the API boundary already validates via zod; this is defense in depth for direct callers).
 */
function validateVerificationConfig(config: RuntimeVerificationConfigSave | null | undefined): void {
	if (config === null || config === undefined) {
		return;
	}
	if (config.enabled !== undefined && config.enabled !== "required" && config.enabled !== "off") {
		throw new Error("verification.enabled must be either 'required' or 'off'.");
	}
	if (config.checks !== undefined && !Array.isArray(config.checks)) {
		throw new Error("verification.checks must be an array.");
	}
	const seenIds = new Set<string>();
	(config.checks ?? []).forEach((check, index) => {
		const label = check?.id?.trim() || `index ${index}`;
		if (!check || typeof check !== "object" || Array.isArray(check)) {
			throw new Error(`verification.checks[${index}] must be an object.`);
		}
		if (!check.id?.trim() || !check.command?.trim()) {
			throw new Error(`verification check "${label}" requires non-empty id and command.`);
		}
		if (seenIds.has(check.id.trim().toLowerCase())) {
			throw new Error(`verification config has duplicate check id "${check.id.trim()}".`);
		}
		seenIds.add(check.id.trim().toLowerCase());
		if (
			check.args !== undefined &&
			(!Array.isArray(check.args) || check.args.some((arg) => typeof arg !== "string"))
		) {
			throw new Error(`verification check "${label}" args must be strings.`);
		}
		if (check.cwd !== undefined && !isSafeVerificationCwd(check.cwd)) {
			throw new Error(`verification check "${label}" cwd must be a relative path inside the worktree.`);
		}
		if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
			throw new Error(`verification check "${label}" timeoutMs must be a positive integer.`);
		}
		if (check.env !== undefined && Object.values(check.env).some((value) => typeof value !== "string")) {
			throw new Error(`verification check "${label}" env values must be strings.`);
		}
		if (
			check.successExitCodes !== undefined &&
			(!Array.isArray(check.successExitCodes) ||
				check.successExitCodes.length === 0 ||
				check.successExitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255))
		) {
			throw new Error(`verification check "${label}" successExitCodes must be a non-empty array of 0-255 integers.`);
		}
	});
}

/** B-7.1: merges a save-shape verification update (null clears everything, undefined leaves it untouched). */
function mergeVerificationUpdates(
	stored: RuntimeVerificationConfig | undefined,
	updates: RuntimeVerificationConfigSave | null | undefined,
): RuntimeVerificationConfigSave | null | undefined {
	if (updates === undefined) {
		return undefined;
	}
	if (updates === null) {
		return null;
	}
	return { ...(stored ?? {}), ...updates };
}

function areRuntimeVerificationConfigsEqual(
	left: RuntimeVerificationConfigSave | null | undefined,
	right: RuntimeVerificationConfigSave | null | undefined,
): boolean {
	// Compare normalized forms: key order in saved objects is not guaranteed,
	// and normalization drops the same invalid data both sides would carry.
	const normalizedLeft = normalizeVerificationConfig(left);
	const normalizedRight = normalizeVerificationConfig(right);
	if (!normalizedLeft && !normalizedRight) {
		return true;
	}
	if (!normalizedLeft || !normalizedRight) {
		return false;
	}
	return (
		normalizedLeft.enabled === normalizedRight.enabled &&
		JSON.stringify(normalizedLeft.checks) === JSON.stringify(normalizedRight.checks)
	);
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	return requests;
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		contextBudget: normalizeContextBudget(globalConfig?.contextBudget),
		reviewPolicy: normalizeReviewPolicy(globalConfig?.reviewPolicy),
		verification: normalizeVerificationConfig(globalConfig?.verification),
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		/** B-2.9: `null` clears the stored context budget; `undefined` preserves the existing one. Null fields clear individual settings (normalized before write). */
		contextBudget?: RuntimeContextBudgetSave | null;
		/** B-6: `null` clears the stored review policy; `undefined` preserves the existing one. */
		reviewPolicy?: RuntimeReviewPolicySave | null;
		/** B-7: `null` clears the stored verification gate; `undefined` preserves the existing one. */
		verification?: RuntimeVerificationConfigSave | null;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const agentAutonomousModeEnabled =
		config.agentAutonomousModeEnabled === undefined
			? DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
			: normalizeBoolean(config.agentAutonomousModeEnabled, DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);

	const payload: RuntimeGlobalConfigFileShape = {};
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentAutonomousModeEnabled !== DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
	) {
		payload.agentAutonomousModeEnabled = agentAutonomousModeEnabled;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}
	if (config.contextBudget !== undefined) {
		if (config.contextBudget !== null) {
			const normalizedContextBudget = normalizeContextBudget(config.contextBudget);
			if (normalizedContextBudget) {
				payload.contextBudget = normalizedContextBudget;
			}
		}
	} else if (existing?.contextBudget) {
		payload.contextBudget = normalizeContextBudget(existing.contextBudget);
	}
	if (config.reviewPolicy !== undefined) {
		if (config.reviewPolicy !== null) {
			const normalizedReviewPolicy = normalizeReviewPolicy(config.reviewPolicy);
			if (normalizedReviewPolicy) {
				payload.reviewPolicy = normalizedReviewPolicy;
			}
		}
	} else if (existing?.reviewPolicy) {
		payload.reviewPolicy = normalizeReviewPolicy(existing.reviewPolicy);
	}
	if (config.verification !== undefined) {
		if (config.verification !== null) {
			const normalizedVerification = normalizeVerificationConfig(config.verification);
			if (normalizedVerification) {
				payload.verification = normalizedVerification;
			}
		}
	} else if (existing?.verification) {
		payload.verification = normalizeVerificationConfig(existing.verification);
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState(configFiles);
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	contextBudget?: RuntimeContextBudgetSave | null;
	reviewPolicy?: RuntimeReviewPolicySave | null;
	verification?: RuntimeVerificationConfigSave | null;
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			input.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(input.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(input.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(input.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		contextBudget: normalizeContextBudget(input.contextBudget),
		reviewPolicy: normalizeReviewPolicy(input.reviewPolicy),
		verification: normalizeVerificationConfig(input.verification),
	};
}

/**
 * B-2.9: reads only the context budget from the global runtime config without
 * the agent auto-selection side effects of loadGlobalRuntimeConfig, so it is
 * safe to call on hot paths (per-session launch config resolution).
 */
export async function readGlobalRuntimeContextBudget(): Promise<RuntimeContextBudget | undefined> {
	const globalConfig = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(getRuntimeGlobalConfigPath());
	return normalizeContextBudget(globalConfig?.contextBudget);
}

/**
 * B-6: reads only the review policy from the global runtime config without the
 * agent auto-selection side effects of loadGlobalRuntimeConfig, so it is safe
 * to call on hot paths (per-task review session startup).
 */
export async function readGlobalRuntimeReviewPolicy(): Promise<RuntimeReviewPolicy | undefined> {
	const globalConfig = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(getRuntimeGlobalConfigPath());
	return normalizeReviewPolicy(globalConfig?.reviewPolicy);
}

/**
 * B-7.1: reads only the verification gate from the global runtime config without the
 * agent auto-selection side effects of loadGlobalRuntimeConfig, so it is safe
 * to call on hot paths (per-task review session startup).
 */
export async function readGlobalRuntimeVerificationConfig(): Promise<RuntimeVerificationConfig | undefined> {
	const globalConfig = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(getRuntimeGlobalConfigPath());
	return normalizeVerificationConfig(globalConfig?.verification);
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		shortcuts: [],
		commitPromptTemplate: current.commitPromptTemplate,
		openPrPromptTemplate: current.openPrPromptTemplate,
		contextBudget: current.contextBudget,
		reviewPolicy: current.reviewPolicy,
		verification: current.verification,
	});
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd),
		async () => await loadRuntimeConfigLocked(cwd),
	);
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(null);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(null),
		async () => await loadRuntimeConfigLocked(null),
	);
}

export async function saveRuntimeConfig(
	cwd: string,
	config: {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		agentAutonomousModeEnabled: boolean;
		readyForReviewNotificationsEnabled: boolean;
		shortcuts: RuntimeProjectShortcut[];
		commitPromptTemplate: string;
		openPrPromptTemplate: string;
		contextBudget?: RuntimeContextBudgetSave | null;
		reviewPolicy?: RuntimeReviewPolicySave | null;
		verification?: RuntimeVerificationConfigSave | null;
	},
): Promise<RuntimeConfigState> {
	validateContextBudget(config.contextBudget);
	validateReviewPolicy(config.reviewPolicy);
	validateVerificationConfig(config.verification);
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
			contextBudget: config.contextBudget,
			reviewPolicy: config.reviewPolicy,
			verification: config.verification,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			shortcuts: config.shortcuts,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
			contextBudget: config.contextBudget,
			reviewPolicy: config.reviewPolicy,
			verification: config.verification,
		});
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	validateContextBudget(updates.contextBudget);
	validateReviewPolicy(updates.reviewPolicy);
	validateVerificationConfig(updates.verification);
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		const mergedContextBudget = mergeContextBudgetUpdates(current.contextBudget, updates.contextBudget);
		const mergedReviewPolicy = mergeReviewPolicyUpdates(current.reviewPolicy, updates.reviewPolicy);
		const mergedVerification = mergeVerificationUpdates(current.verification, updates.verification);
		const nextConfig = {
			selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
			selectedShortcutLabel:
				updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
			agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled:
				updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
			shortcuts: projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts,
			commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
			openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
			contextBudget: mergedContextBudget === undefined ? current.contextBudget : mergedContextBudget,
			reviewPolicy: mergedReviewPolicy === undefined ? current.reviewPolicy : mergedReviewPolicy,
			verification: mergedVerification === undefined ? current.verification : mergedVerification,
		};

		const hasChanges =
			nextConfig.selectedAgentId !== current.selectedAgentId ||
			nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
			nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
			nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
			nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
			nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
			!areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts) ||
			!areRuntimeContextBudgetsEqual(nextConfig.contextBudget, current.contextBudget) ||
			!areRuntimeReviewPoliciesEqual(nextConfig.reviewPolicy, current.reviewPolicy) ||
			!areRuntimeVerificationConfigsEqual(nextConfig.verification, current.verification);

		if (!hasChanges) {
			return current;
		}

		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			contextBudget: updates.contextBudget === undefined ? undefined : mergedContextBudget,
			reviewPolicy: updates.reviewPolicy === undefined ? undefined : mergedReviewPolicy,
			verification: updates.verification === undefined ? undefined : mergedVerification,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextConfig.shortcuts,
		});
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			shortcuts: nextConfig.shortcuts,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			contextBudget: nextConfig.contextBudget,
			reviewPolicy: nextConfig.reviewPolicy,
			verification: nextConfig.verification,
		});
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	validateContextBudget(updates.contextBudget);
	validateReviewPolicy(updates.reviewPolicy);
	validateVerificationConfig(updates.verification);
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(
		[
			{
				path: globalConfigPath,
				type: "file",
			},
		],
		async () => {
			const mergedContextBudget = mergeContextBudgetUpdates(current.contextBudget, updates.contextBudget);
			const mergedReviewPolicy = mergeReviewPolicyUpdates(current.reviewPolicy, updates.reviewPolicy);
			const mergedVerification = mergeVerificationUpdates(current.verification, updates.verification);
			const nextConfig = {
				selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
				selectedShortcutLabel:
					updates.selectedShortcutLabel === undefined
						? current.selectedShortcutLabel
						: updates.selectedShortcutLabel,
				agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled:
					updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
				shortcuts: current.shortcuts,
				commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
				openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
				contextBudget: mergedContextBudget === undefined ? current.contextBudget : mergedContextBudget,
				reviewPolicy: mergedReviewPolicy === undefined ? current.reviewPolicy : mergedReviewPolicy,
				verification: mergedVerification === undefined ? current.verification : mergedVerification,
			};

			const hasChanges =
				nextConfig.selectedAgentId !== current.selectedAgentId ||
				nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
				nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
				nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
				nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
				nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
				!areRuntimeContextBudgetsEqual(nextConfig.contextBudget, current.contextBudget) ||
				!areRuntimeReviewPoliciesEqual(nextConfig.reviewPolicy, current.reviewPolicy) ||
				!areRuntimeVerificationConfigsEqual(nextConfig.verification, current.verification);

			if (!hasChanges) {
				return current;
			}

			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
				contextBudget: updates.contextBudget === undefined ? undefined : mergedContextBudget,
				reviewPolicy: updates.reviewPolicy === undefined ? undefined : mergedReviewPolicy,
				verification: updates.verification === undefined ? undefined : mergedVerification,
			});

			return createRuntimeConfigStateFromValues({
				globalConfigPath,
				projectConfigPath: current.projectConfigPath,
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				shortcuts: nextConfig.shortcuts,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
				contextBudget: nextConfig.contextBudget,
				reviewPolicy: nextConfig.reviewPolicy,
				verification: nextConfig.verification,
			});
		},
	);
}
