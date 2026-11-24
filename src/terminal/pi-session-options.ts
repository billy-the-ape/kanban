// AA-P1: Pi (Badlogic Games `pi-coding-agent`) integration paths and launch
// planning.
//
// Kanban never re-implements Pi's provider, authentication or model
// configuration. Every value in this file is either a Kanban-owned path or a
// value read from Pi's own configuration files, so a `pi` started by hand in the
// same directory keeps working untouched.
import { createHash } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getRuntimeHomePath } from "../state/workspace-state";
import { toResourceScopeSegment } from "./agent-launch-helpers";

/** Environment override Pi itself reads for the agent (config) directory. */
export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export const PI_AGENT_DIR_NAME = ".pi";
export const PI_AGENT_SUBDIR_NAME = "agent";
/**
 * Pi keeps its provider catalogue and its credentials (`models.json`,
 * `auth.json`, `trust.json`) next to this settings file. Kanban reads the
 * settings file only: `auth.json` holds API keys and OAuth tokens, so it is
 * never read or copied, and project trust is never granted on the user's
 * behalf.
 */
export const PI_SETTINGS_FILENAME = "settings.json";

/** Pi only loads extension files ending in `.ts` or `.js` (extensions/loader). */
export const PI_HOOK_EXTENSION_FILENAME = "kanban-pi-hook.js";

/** Flags that select a session; Kanban's own exact-session flags must not fight them. */
const PI_SESSION_SELECTION_FLAGS = ["--session", "--session-id", "--continue", "-c", "--resume", "-r"] as const;
const PI_TRUST_FLAGS = ["--approve", "-a", "--no-approve", "-na"] as const;
const PI_MODEL_FLAGS = ["--model", "--provider"] as const;

export interface PiSessionScope {
	workspaceId: string;
	taskId: string;
}

function normalizePath(value: string): string {
	return resolve(value);
}

/**
 * Pi's own agent directory. Honours `PI_CODING_AGENT_DIR` because Pi does, so a
 * user who relocated their config still sees the same files through Kanban.
 */
export function getPiAgentDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
	const override = env[PI_CODING_AGENT_DIR_ENV]?.trim();
	if (override) {
		return normalizePath(override);
	}
	return join(homeDir, PI_AGENT_DIR_NAME, PI_AGENT_SUBDIR_NAME);
}

export function getPiSettingsPath(agentDir: string = getPiAgentDir()): string {
	return join(agentDir, PI_SETTINGS_FILENAME);
}

/** Kanban-owned root for per-task Pi session directories. */
export function getPiSessionsRootPath(): string {
	return join(getRuntimeHomePath(), "pi", "sessions");
}

/**
 * Durable, per-workspace/task Pi session directory. Pi writes every session of
 * this scope here, so a task can never resume another task's session and the
 * global `~/.pi` catalogue stays free of Kanban bookkeeping.
 */
export function getPiTaskSessionDir(scope: PiSessionScope): string {
	return join(
		getPiSessionsRootPath(),
		toResourceScopeSegment(scope.workspaceId),
		toResourceScopeSegment(scope.taskId),
	);
}

/**
 * Pi accepts ids matching this pattern (`assertValidSessionId` in Pi's session
 * manager). Kanban mints the id once per task and reuses it for every later
 * launch, so a resume always names the session Kanban started.
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidPiSessionId(value: string): boolean {
	return PI_SESSION_ID_PATTERN.test(value);
}

/** Deterministic Pi session id for one task, so a restart resumes the same file. */
export function derivePiSessionId(scope: PiSessionScope): string {
	const hash = createHash("sha256")
		.update(`pi-session\0${scope.workspaceId}\0${scope.taskId}`)
		.digest("hex")
		.slice(0, 32);
	const id = `kanban-${hash}`;
	// Guard the invariant Pi enforces instead of discovering it at launch time.
	return isValidPiSessionId(id) ? id : `kanban-${hash.slice(0, 24)}`;
}

export interface PiSessionRecord {
	/** True when Pi's session file for the Kanban-owned id already exists. */
	found: boolean;
	/** Absolute path of the session JSONL file, when found. */
	sessionFile: string | null;
	/** Working directory recorded in the session header, when found. */
	sessionCwd: string | null;
}

function readSessionHeader(line: string): { id?: string; cwd?: string } | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const record = parsed as Record<string, unknown>;
		return {
			...(typeof record.id === "string" ? { id: record.id } : {}),
			...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Reads back the session Kanban owns for this task. Used to prove a launch
 * resumes an existing session and to surface a missing session in diagnostics
 * instead of silently starting a new conversation.
 */
export async function readPiSessionRecord(input: { sessionId: string; sessionDir: string }): Promise<PiSessionRecord> {
	const sessionDir = input.sessionDir;
	let entries: string[];
	try {
		entries = await readdir(sessionDir);
	} catch {
		return { found: false, sessionFile: null, sessionCwd: null };
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".jsonl")) {
			continue;
		}
		const sessionFile = join(sessionDir, entry);
		let head: string;
		try {
			// A diagnostics export must not load a potentially huge JSONL file
			// merely to verify the session id stored in its first line.
			const handle = await open(sessionFile, "r");
			try {
				const headerBytes = Buffer.alloc(4096);
				const { bytesRead } = await handle.read(headerBytes, 0, headerBytes.length, 0);
				head = headerBytes.toString("utf8", 0, bytesRead);
			} finally {
				await handle.close();
			}
		} catch {
			continue;
		}
		const firstLine = head.split("\n", 1)[0] ?? "";
		const header = readSessionHeader(firstLine);
		if (header?.id === input.sessionId) {
			return { found: true, sessionFile, sessionCwd: header.cwd ?? null };
		}
	}
	return { found: false, sessionFile: null, sessionCwd: null };
}

export interface PiModelDefaults {
	/** `defaultProvider` from Pi's own settings, when explicitly configured. */
	defaultProvider: string | null;
	/** `defaultModel` from Pi's own settings, when explicitly configured. */
	defaultModel: string | null;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, { encoding: "utf8" }));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Reads only the two settings that decide which model a Pi session starts with.
 * A malformed or missing settings file means “no explicit selection”, which is
 * Pi's own automatic default - Kanban then passes nothing.
 */
export async function readPiModelDefaults(agentDir: string = getPiAgentDir()): Promise<PiModelDefaults> {
	const settings = await readJsonObject(getPiSettingsPath(agentDir));
	const defaultProvider = typeof settings?.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
	const defaultModel = typeof settings?.defaultModel === "string" ? settings.defaultModel.trim() : "";
	return {
		defaultProvider: defaultProvider.length > 0 ? defaultProvider : null,
		defaultModel: defaultModel.length > 0 ? defaultModel : null,
	};
}

export interface PiModelFlags {
	/** Flags to append to the launch. Empty when Pi should pick its own default. */
	args: string[];
	/** Model identity Kanban explicitly asked for, for launch provenance. */
	requestedModel: string | null;
}

/**
 * Pi's settings decide the model; Kanban only repeats the request explicitly.
 * A `defaultModel` with no `defaultProvider` is forwarded as a bare `--model`
 * so Pi resolves the provider from its own catalogue, and a provider with no
 * model is not a model request at all. Kanban never invents either value, and
 * never falls back to a hosted provider.
 */
export function resolvePiModelFlags(defaults: PiModelDefaults): PiModelFlags {
	if (defaults.defaultModel && defaults.defaultProvider) {
		return {
			args: ["--provider", defaults.defaultProvider, "--model", defaults.defaultModel],
			requestedModel: formatPiModelRef({
				provider: defaults.defaultProvider,
				model: defaults.defaultModel,
			}),
		};
	}
	if (defaults.defaultModel) {
		return { args: ["--model", defaults.defaultModel], requestedModel: defaults.defaultModel };
	}
	return { args: [], requestedModel: null };
}

/** `provider/model`, the shape both Pi and Kanban's diagnostics display. */
function formatPiModelRef(ref: { provider: string | null; model: string | null }): string | null {
	const provider = ref.provider?.trim() ?? "";
	const model = ref.model?.trim() ?? "";
	if (provider.length > 0 && model.length > 0) {
		return model.includes("/") ? model : `${provider}/${model}`;
	}
	return model.length > 0 ? model : provider.length > 0 ? provider : null;
}

export interface PiLaunchArgsInput {
	/** Args the user/config already supplied, kept first and never overridden. */
	args: readonly string[];
	sessionDir: string;
	sessionId: string;
	/** Generated Kanban extension path, or null when no hook owner exists. */
	extensionPath: string | null;
	/** Explicit model flags from Pi's own settings, when configured. */
	modelArgs?: readonly string[] | undefined;
	/** Ignore project-local resources for this unattended run. */
	trustProjectResources?: boolean | undefined;
}

function hasAnyCliOption(args: readonly string[], names: readonly string[]): boolean {
	return names.some((name) => args.includes(name));
}

/**
 * The flags of one Pi launch, prompt excluded. Kanban pins the exact session
 * (`--session-dir` + `--session-id`) instead of asking Pi for “the latest
 * session”, and a user-supplied equivalent always wins.
 */
export function buildPiLaunchArgs(input: PiLaunchArgsInput): string[] {
	const args = [...input.args];
	const launch: string[] = [];
	if (!hasAnyCliOption(args, PI_SESSION_SELECTION_FLAGS) && !hasAnyCliOption(args, ["--session-dir"])) {
		launch.push("--session-dir", input.sessionDir, "--session-id", input.sessionId);
	}
	if (input.extensionPath && !args.includes(input.extensionPath)) {
		launch.push("--extension", input.extensionPath);
	}
	if (input.trustProjectResources !== true && !hasAnyCliOption(args, PI_TRUST_FLAGS)) {
		launch.push("--no-approve");
	}
	if (!hasAnyCliOption(args, PI_MODEL_FLAGS)) {
		launch.push(...(input.modelArgs ?? []));
	}
	args.push(...launch);
	return args;
}
