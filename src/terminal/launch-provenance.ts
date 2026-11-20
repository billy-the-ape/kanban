import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { getRuntimeAgentModelConfiguration } from "../core/agent-capabilities";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskLaunchProvenance } from "../core/api-contract";
import {
	KANBAN_HOOK_ATTEMPT_ID_ENV,
	KANBAN_HOOK_TASK_ID_ENV,
	KANBAN_HOOK_WORKSPACE_ID_ENV,
} from "./hook-runtime-context";

/**
 * AA-S1: launch provenance.
 *
 * The provenance record answers one question for an operator debugging a
 * session: which agent binary and which configuration did this attempt
 * actually start with? Requested settings (what Kanban asked for) and observed
 * settings (what the agent reports using) are kept distinct, and unknown
 * values stay `null` rather than borrowing another agent's configuration.
 */

/** Environment names that carry credentials rather than configuration. */
const SECRET_ENV_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|CERT|PAT$|PRIVATE)/i;

/** Environment names that plausibly describe agent configuration. */
const CONFIG_ENV_KEY_PATTERN =
	/^(KANBAN_|CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_|GEMINI_|GOOGLE_|OPENCODE_|DROID_|FACTORY_|KIRO_|MODEL|AGENT|PROVIDER|.*_MODEL|.*_PROVIDER|.*_BASE_URL|.*_BASEURI|XDG_)/i;

/**
 * The hook runtime environment carries the identity of one launch (task,
 * workspace and the ownership token). None of it is configuration, and the
 * attempt token changes on every start, so hashing it would make every launch
 * look like a configuration change.
 */
const HOOK_IDENTITY_ENV_KEYS: ReadonlySet<string> = new Set([
	KANBAN_HOOK_TASK_ID_ENV,
	KANBAN_HOOK_WORKSPACE_ID_ENV,
	KANBAN_HOOK_ATTEMPT_ID_ENV,
]);

const REDACTED_PLACEHOLDER = "<redacted>";
const KANBAN_HOME_PLACEHOLDER = "<kanban-home>";
const TMP_PLACEHOLDER = "<tmp>";
const SCOPE_PLACEHOLDER = "<scope>";
const MAX_FINGERPRINT_PART_LENGTH = 200;

function getRuntimeHomePrefix(): string {
	return `${homedir()}/.cline/kanban`;
}

/**
 * Normalizes machine-specific volatility out of a fingerprint input: home and
 * temp prefixes, and the per-launch generated resource directories under the
 * Kanban runtime home. Without this, every launch would look like a
 * configuration change.
 */
function normalizeFingerprintValue(value: string): string {
	const runtimeHome = getRuntimeHomePrefix();
	const windowsRuntimeHome = runtimeHome.replaceAll("/", "\\");
	let normalized = value
		.split(runtimeHome)
		.join(KANBAN_HOME_PLACEHOLDER)
		.split(windowsRuntimeHome)
		.join(KANBAN_HOME_PLACEHOLDER);
	const home = homedir();
	if (home.length > 1) {
		normalized = normalized.split(home).join("~");
		normalized = normalized.split(home.replaceAll("\\", "\\\\")).join("~");
	}
	const temp = tmpdir();
	if (temp.length > 1) {
		normalized = normalized.split(temp).join(TMP_PLACEHOLDER);
		normalized = normalized.split(temp.replaceAll("\\", "\\\\")).join(TMP_PLACEHOLDER);
	}
	normalized = normalized.replaceAll(/[A-Za-z0-9._-]{1,60}-[0-9a-f]{10}(?![0-9a-f])/g, SCOPE_PLACEHOLDER);
	normalized = normalized.replaceAll(/\s+/g, " ").trim();
	return normalized.length > MAX_FINGERPRINT_PART_LENGTH
		? `${normalized.slice(0, MAX_FINGERPRINT_PART_LENGTH)}…`
		: normalized;
}

export function isSecretLikeEnvKey(key: string): boolean {
	return SECRET_ENV_KEY_PATTERN.test(key);
}

function isConfigLikeEnvKey(key: string): boolean {
	return CONFIG_ENV_KEY_PATTERN.test(key) && !isSecretLikeEnvKey(key);
}

/**
 * Fingerprint inputs: the agent and binary, the launch arguments (flag values
 * included, prompt text excluded), the configuration-shaped part of the
 * environment and the configuration locations. Values that are not
 * configuration-shaped are left out entirely, and so is every credential - its
 * name as well as its value - so the fingerprint never encodes a secret or the
 * whole process environment.
 */
export function collectLaunchConfigFingerprintParts(input: {
	agentId: RuntimeAgentId | null;
	binary: string;
	args: readonly string[];
	env?: Readonly<Record<string, string | undefined>> | undefined;
	/** The launch prompt; positional prompt text is not configuration. */
	prompt?: string | undefined;
	configLocations?: readonly string[] | undefined;
}): string[] {
	const trimmedPrompt = input.prompt?.trim();
	const parts: string[] = [`agent=${input.agentId ?? "unknown"}`, `binary=${normalizeFingerprintValue(input.binary)}`];
	let expectsFlagValue = false;
	for (const arg of input.args) {
		const normalized = normalizeFingerprintValue(arg);
		const isFlag = arg.startsWith("-");
		const isFlagValue = expectsFlagValue;
		// Set before any `continue` so skipping an argument cannot desynchronize
		// which following value belongs to which flag.
		expectsFlagValue = isFlag && !arg.includes("=");
		if (!normalized || (trimmedPrompt !== undefined && normalized === normalizeFingerprintValue(trimmedPrompt))) {
			continue;
		}
		// A bare positional value (a prompt, pasted instructions) is not
		// configuration, but the value of a flag is (`--permission-mode auto`).
		if (!isFlag && !isFlagValue && !normalized.includes("=")) {
			continue;
		}
		parts.push(`arg=${normalized}`);
	}
	for (const key of Object.keys(input.env ?? {}).sort()) {
		if (HOOK_IDENTITY_ENV_KEYS.has(key) || !isConfigLikeEnvKey(key)) {
			continue;
		}
		const value = input.env?.[key];
		// Credentials never reach this loop (see `isConfigLikeEnvKey`), so the only
		// placeholder case is a configuration variable that is declared but unset.
		parts.push(
			value === undefined ? `env=${key}=${REDACTED_PLACEHOLDER}` : `env=${key}=${normalizeFingerprintValue(value)}`,
		);
	}
	for (const location of [...(input.configLocations ?? [])].sort()) {
		parts.push(`config=${normalizeFingerprintValue(location)}`);
	}
	return parts;
}

export function buildLaunchConfigFingerprint(input: {
	agentId: RuntimeAgentId | null;
	binary: string;
	args: readonly string[];
	env?: Readonly<Record<string, string | undefined>> | undefined;
	prompt?: string | undefined;
	configLocations?: readonly string[] | undefined;
}): string {
	const parts = collectLaunchConfigFingerprintParts(input);
	return `sha256:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}

const MODEL_ARG_NAMES = ["--model", "-m", "--model-id", "--llm"] as const;

/**
 * The model Kanban explicitly asked this agent to use, read back from the
 * launch arguments. `null` when nothing was requested — which is the normal
 * case for agents that own their own model selection.
 */
export function extractRequestedModelFromLaunchArgs(args: readonly string[]): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const inlineMatch = /^(--model|--model-id|--llm|-m)=(.+)$/i.exec(arg);
		if (inlineMatch?.[2]) {
			return inlineMatch[2].trim();
		}
		if ((MODEL_ARG_NAMES as readonly string[]).includes(arg)) {
			const next = args[index + 1];
			if (next && !next.startsWith("-")) {
				return next.trim();
			}
		}
	}
	return null;
}

export interface CreateLaunchProvenanceInput {
	attemptId: string;
	agentId: RuntimeAgentId | null;
	binary: string;
	args: readonly string[];
	env?: Readonly<Record<string, string | undefined>> | undefined;
	prompt?: string | undefined;
	cwd: string;
	taskId: string;
	workspaceId: string | null;
	startedAt: number;
	/** Version reported by the agent itself; never guessed. */
	agentVersion?: string | null | undefined;
	/** Model the agent reported using; never inferred. */
	observedModel?: string | null | undefined;
	/** The previous launch's fingerprint, or null on a first launch for this task. */
	previousConfigFingerprint?: string | null | undefined;
}

export function createLaunchProvenance(input: CreateLaunchProvenanceInput): RuntimeTaskLaunchProvenance {
	const agentId = input.agentId;
	const modelConfiguration = agentId ? getRuntimeAgentModelConfiguration(agentId) : null;
	const catalogEntry = agentId ? getRuntimeAgentCatalogEntry(agentId) : null;
	const configLocations = modelConfiguration?.configLocations ?? [];
	const previousConfigFingerprint = input.previousConfigFingerprint ?? null;
	const configFingerprint = buildLaunchConfigFingerprint({
		agentId,
		binary: input.binary,
		args: input.args,
		env: input.env,
		prompt: input.prompt,
		configLocations,
	});
	return {
		attemptId: input.attemptId,
		agentId,
		agentLabel: catalogEntry?.label ?? null,
		binary: input.binary,
		agentVersion: input.agentVersion ?? null,
		requestedModel: extractRequestedModelFromLaunchArgs(input.args),
		observedModel: input.observedModel ?? null,
		modelSource: modelConfiguration?.source ?? "unknown",
		configLocations: [...configLocations],
		configFingerprint,
		previousConfigFingerprint,
		cwd: input.cwd,
		taskId: input.taskId,
		workspaceId: input.workspaceId,
		startedAt: input.startedAt,
	};
}

/**
 * Turn the two fingerprints a session records into one change fact. A change is
 * only reported when both launches have a fingerprint; the first launch of a
 * task has nothing to compare against.
 *
 * AA-S1 records both fingerprints on the session summary; nothing in a shipped
 * surface renders this comparison yet. AA-O1/AA-P1 call it to display the
 * resume-after-configuration-change notice required for their agents instead of
 * re-deriving what counts as a configuration difference.
 */
export function didLaunchConfigurationChange(
	previous: RuntimeTaskLaunchProvenance | null | undefined,
	next: Pick<RuntimeTaskLaunchProvenance, "configFingerprint">,
): boolean {
	if (!previous?.configFingerprint) {
		return false;
	}
	return previous.configFingerprint !== next.configFingerprint;
}
