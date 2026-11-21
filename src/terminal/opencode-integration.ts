import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * AA-O1: the single boundary where Kanban encodes OpenCode-specific facts.
 *
 * Everything here is pinned against a released OpenCode build (see
 * `OPENCODE_PINNED_VERSION`) and was verified against that build's own
 * `--help` output and runtime behaviour rather than reproduced from memory:
 *
 * - `opencode run --help` publishes `--session <id>` ("session id to
 *   continue"), so exact external-session resume is available and
 *   `--continue` ("continue the last session") is never acceptable for a
 *   Kanban card. Passing an unknown id fails with `Session not found`
 *   (exit 1) instead of silently starting another session.
 * - `opencode export <sessionID>` exits 1 with `Session not found` for an
 *   unknown id, and `opencode session list` prints the project's sessions,
 *   which gives Kanban a cheap project-scoped existence probe.
 * - `OPENCODE_CONFIG=<file>` is merged as an extra configuration source: the
 *   user's global and project configuration (providers, credentials, agents,
 *   MCP servers, instructions) keeps loading unchanged, so Kanban only adds
 *   an overlay instead of replacing it.
 * - In the pinned release the configuration key is `plugin` and an entry may
 *   be a local directory. The newer `plugins` key is reported as an
 *   unsupported setting, so the overlay writes `plugin` only.
 * - Model identity is `provider/model`; an unresolvable selector fails loudly
 *   with `ProviderModelNotFoundError`, which is why Kanban never guesses one.
 *
 * Keep new version-specific translation in this file so the OpenCode adapter
 * stays a thin policy layer.
 */

/** Release the plugin contract and launch flags below were verified against. */
export const OPENCODE_PINNED_VERSION = "1.19.6";

/** Oldest release whose `run`/TUI flags and plugin contract Kanban supports. */
export const OPENCODE_MINIMUM_VERSION: OpenCodeVersion = { major: 1, minor: 19, patch: 0 };

/** Kanban-owned overrides the user can set for an OpenCode launch. */
export const KANBAN_OPENCODE_MODEL_ENV = "KANBAN_OPENCODE_MODEL";
export const KANBAN_OPENCODE_SESSION_ID_ENV = "KANBAN_OPENCODE_SESSION_ID";

/**
 * Documented model selector shape: `provider/model`, where the model id itself
 * may contain slashes (OpenRouter publishes `openrouter/anthropic/claude-...`)
 * and colons (Ollama tags a model as `qwen2.5-coder:32b`), and a segment may
 * carry a `#variant` suffix. A bare word without a provider is rejected so an
 * unqualified value never reaches the CLI.
 */
const OPENCODE_MODEL_SELECTOR_PATTERN =
	/^[A-Za-z0-9._:+-]+(?:#[A-Za-z0-9._:+-]+)?(?:\/[A-Za-z0-9._:+-]+(?:#[A-Za-z0-9._:+-]+)?)+$/;
const OPENCODE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,200}$/;

export interface OpenCodeVersion {
	major: number;
	minor: number;
	patch: number;
}

export type OpenCodeCompatibilityStatus = "supported" | "unknown" | "unsupported";

export interface OpenCodeCompatibility {
	status: OpenCodeCompatibilityStatus;
	version: OpenCodeVersion | null;
	/** Human-readable remediation for an unsupported release; null when fine. */
	remediation: string | null;
}

export type OpenCodeModelSource = "kanban-env" | "agent-config" | "none" | "invalid";

export interface OpenCodeModelSelection {
	/** `provider/model` to pass as `--model`, or null to defer to OpenCode. */
	model: string | null;
	source: OpenCodeModelSource;
	/** Config file the model came from, when it came from the user's config. */
	configPath: string | null;
	/** Set when the user asked for a model that Kanban could not honour. */
	warning: string | null;
}

export interface OpenCodeLaunchProbeOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
}

function toSpawnEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
	if (!env) {
		return process.env;
	}
	const merged: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") {
			merged[key] = value;
		}
	}
	return merged;
}

interface SpawnCaptureResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	failure: string | null;
}

/**
 * Runs one short-lived OpenCode command and captures bounded output. Used for
 * version and session-existence probes, so a hung CLI must never pin the
 * launch path: the child is killed once `timeoutMs` elapses.
 */
function spawnCapture(
	binary: string,
	args: string[],
	options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number },
): Promise<SpawnCaptureResult> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, args, {
				cwd: options.cwd,
				env: toSpawnEnv(options.env),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({
				exitCode: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				failure: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		const append = (current: string, chunk: Buffer | string): string =>
			current.length >= 65536 ? current : current + chunk.toString();
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (error: Error) => {
			clearTimeout(timer);
			resolve({ exitCode: null, stdout, stderr, timedOut, failure: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: timedOut ? null : code, stdout, stderr, timedOut, failure: null });
		});
	});
}

/** Reads the first `1.2.3`-shaped token out of `opencode --version` output. */
export function parseOpenCodeVersion(raw: string | null | undefined): OpenCodeVersion | null {
	if (typeof raw !== "string") {
		return null;
	}
	const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return null;
	}
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatOpenCodeVersion(version: OpenCodeVersion | null): string {
	if (!version) {
		return "unknown";
	}
	return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * An unreadable version is reported as `unknown` and allowed: Kanban must keep
 * the card visible with guidance instead of blocking a perfectly good CLI
 * because `--version` printed something unexpected. A detected release below
 * `OPENCODE_MINIMUM_VERSION` is blocked, because its flags and plugin
 * contract are the ones this module does not describe.
 */
export function isOpenCodeVersionSupported(version: OpenCodeVersion | null): boolean {
	if (!version) {
		return true;
	}
	const minimum = OPENCODE_MINIMUM_VERSION;
	if (version.major < minimum.major) {
		return false;
	}
	if (version.major > minimum.major) {
		return true;
	}
	if (version.minor < minimum.minor) {
		return false;
	}
	return true;
}

export function describeOpenCodeCompatibility(rawVersion: string | null | undefined): OpenCodeCompatibility {
	const version = parseOpenCodeVersion(rawVersion ?? null);
	if (!version) {
		return {
			status: "unknown",
			version: null,
			remediation: null,
		};
	}
	if (isOpenCodeVersionSupported(version)) {
		return { status: "supported", version, remediation: null };
	}
	return {
		status: "unsupported",
		version,
		remediation:
			`OpenCode ${formatOpenCodeVersion(version)} is too old for Kanban: upgrade to ` +
			`${OPENCODE_PINNED_VERSION} or newer (https://opencode.ai/docs/). Kanban needs the ` +
			`${formatOpenCodeVersion(OPENCODE_MINIMUM_VERSION)} launch flags and plugin contract.`,
	};
}

/** Asks the pinned CLI for its version; null means it could not be read. */
export async function probeOpenCodeVersion(
	binary: string,
	options: OpenCodeLaunchProbeOptions,
): Promise<OpenCodeVersion | null> {
	const trimmed = binary.trim();
	if (!trimmed) {
		return null;
	}
	const result = await spawnCapture(trimmed, ["--version"], {
		cwd: options.cwd,
		env: options.env,
		timeoutMs: options.timeoutMs ?? 5000,
	});
	return parseOpenCodeVersion(`${result.stdout} ${result.stderr}`);
}

/**
 * Exact external-session probe (AA-O1a). `opencode session list` is scoped to
 * the project the CLI is run from, which is exactly the scope Kanban wants: a
 * session id recorded by another workspace or task must not be resumed.
 * `null` means the probe itself failed, in which case the caller launches and
 * lets OpenCode reject an unknown id loudly.
 */
export async function verifyOpenCodeSession(
	sessionId: string,
	options: OpenCodeLaunchProbeOptions & { binary: string },
): Promise<boolean | null> {
	const trimmed = sessionId.trim();
	if (!OPENCODE_SESSION_ID_PATTERN.test(trimmed)) {
		return false;
	}
	const binary = options.binary.trim();
	if (!binary) {
		return null;
	}
	const result = await spawnCapture(binary, ["session", "list"], {
		cwd: options.cwd,
		env: options.env,
		timeoutMs: options.timeoutMs ?? 10000,
	});
	if (result.failure !== null || result.timedOut || result.exitCode !== 0) {
		return null;
	}
	// The list output is human-readable columns, so the id is compared as a
	// whole field: a prefix of one session id must not match another session.
	return result.stdout.split(/\r?\n/).some((line) => line.split(/[\s,;|]+/).some((field) => field === trimmed));
}

// ── Configuration overlay ──────────────────────────────────────────────────

/**
 * A single external plugin is not a reason to touch the user's files: Kanban
 * writes its own overlay into the per-attempt directory and points
 * `OPENCODE_CONFIG` at it. The pinned release merges that file with the user's
 * global and project configuration instead of replacing them, and a local
 * plugin entry must be a directory containing an ES-module entry point.
 */
export interface OpenCodeConfigOverlay {
	/** Generated overlay file to publish as `OPENCODE_CONFIG`. */
	configPath: string;
	/** Absolute plugin directory handed to OpenCode's `plugin` setting. */
	pluginDirectory: string;
	/** Package manifest that makes the directory importable as a plugin. */
	manifestPath: string;
	/** Plugin entry point generated for this launch attempt. */
	entryPointPath: string;
}

/** Layout of the files Kanban generates for one launch attempt. */
export function getOpenCodeOverlayLayout(directory: string, overlayFileName = "opencode.json"): OpenCodeConfigOverlay {
	const pluginDirectory = join(directory, "plugin");
	return {
		configPath: join(directory, overlayFileName),
		pluginDirectory,
		manifestPath: join(pluginDirectory, "package.json"),
		entryPointPath: join(pluginDirectory, "index.js"),
	};
}

/**
 * Overlay content for the pinned release. `plugin` is the key that release
 * reads; the newer `plugins` key is dropped by it with an "unsupported
 * setting" diagnostic, so emitting only `plugin` keeps the bridge alive on the
 * supported range without fighting the newer schema.
 */
export function buildOpenCodeOverlayConfigContent(overlay: OpenCodeConfigOverlay): string {
	return `${JSON.stringify(
		{
			$schema: "https://opencode.ai/config.json",
			plugin: [overlay.pluginDirectory],
		},
		null,
		2,
	)}\n`;
}

/**
 * Manifest that turns the generated directory into an importable ES module.
 * `type: module` matters: the generated entry point uses `export default`.
 */
export function buildOpenCodePluginManifestContent(): string {
	return `${JSON.stringify(
		{
			name: "kanban-opencode-hooks",
			version: "0.0.0",
			private: true,
			type: "module",
			main: "./index.js",
			description: "Kanban launch-attempt bridge for OpenCode session events.",
		},
		null,
		2,
	)}\n`;
}

// ── Model identity ─────────────────────────────────────────────────────────

export function isOpenCodeModelSelector(value: string): boolean {
	const trimmed = value.trim();
	// A value that starts like a flag is rejected even though it is passed as a
	// separate argv element, so a bad config cannot smuggle an option in.
	if (trimmed.startsWith("-")) {
		return false;
	}
	return OPENCODE_MODEL_SELECTOR_PATTERN.test(trimmed);
}

export function isOpenCodeSessionSelector(value: string): boolean {
	return OPENCODE_SESSION_ID_PATTERN.test(value.trim());
}

function readEnvValue(env: Record<string, string | undefined> | undefined, key: string): string | null {
	const value = env ? env[key] : process.env[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function getXdgConfigHome(env: Record<string, string | undefined> | undefined): string {
	const configured = readEnvValue(env, "XDG_CONFIG_HOME");
	if (configured) {
		return configured;
	}
	return join(homedir(), ".config");
}

/**
 * Directories OpenCode has used for its global file: the `opencode`
 * subdirectory the current docs publish, the XDG (or AppData) config directory
 * itself, and the legacy `~/.opencode` home directory. Listing all three keeps
 * a model the user selected in any supported location working, and says nothing
 * about credentials (which live in the auth store) or model catalogs (state).
 */
function getGlobalConfigDirectories(env: Record<string, string | undefined> | undefined): string[] {
	const roots: (string | null)[] =
		process.platform === "win32"
			? [readEnvValue(env, "APPDATA"), readEnvValue(env, "LOCALAPPDATA")]
			: [getXdgConfigHome(env)];
	const directories: string[] = [];
	for (const root of roots) {
		if (!root) {
			continue;
		}
		directories.push(join(root, "opencode"), root);
	}
	directories.push(join(homedir(), ".opencode"));
	return directories;
}

/**
 * OpenCode configuration files Kanban may read, ordered from lowest to highest
 * precedence. Only configuration is read: credentials live in OpenCode's auth
 * store and model catalogs live in its state directory, and neither is a
 * source of truth for which model a card should run (AA-O1a).
 */
export function getOpenCodeConfigPathCandidates(options: {
	cwd: string;
	env?: Record<string, string | undefined>;
}): string[] {
	const env = options.env;
	const configured = readEnvValue(env, "OPENCODE_CONFIG");
	const candidates: string[] = [];
	if (configured) {
		candidates.push(configured);
	}
	for (const directory of getGlobalConfigDirectories(env)) {
		candidates.push(join(directory, "opencode.json"), join(directory, "opencode.jsonc"));
	}
	const project = options.cwd;
	candidates.push(
		join(project, "opencode.json"),
		join(project, "opencode.jsonc"),
		join(project, ".opencode", "opencode.json"),
		join(project, ".opencode", "opencode.jsonc"),
	);
	return candidates;
}

/** Locations shown in Settings so a user knows where to configure the model. */
export function getOpenCodeConfigLocationHints(options: {
	cwd: string;
	env?: Record<string, string | undefined>;
}): string[] {
	const directories = [...getGlobalConfigDirectories(options.env), join(options.cwd, ".opencode")];
	const hints = new Set<string>();
	for (const directory of directories) {
		hints.add(join(directory, "opencode.json"));
		hints.add(join(directory, "opencode.jsonc"));
	}
	return [...hints];
}

/** Removes `//` and block comments and trailing commas so JSONC parses. */
export function stripJsonComments(input: string): string {
	let result = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	let quoteChar = "";
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		const next = index + 1 < input.length ? input[index + 1] : "";
		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				result += char;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			result += char;
			if (char === "\\") {
				const following = index + 1 < input.length ? input[index + 1] : "";
				result += following;
				index += 1;
				continue;
			}
			if (char === quoteChar) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quoteChar = char;
			result += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}
		result += char;
	}
	return result.replaceAll(/,(\s*[}\]])/g, "$1");
}

/**
 * Reads the `model` a user selected for themselves. That selection is the
 * user's explicit choice, so honouring it satisfies the explicit-model
 * requirement without Kanban guessing a hosted provider.
 */
export function extractOpenCodeModelFromConfig(raw: string): string | null {
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(raw));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const model = (parsed as { model?: unknown }).model;
		if (typeof model !== "string") {
			return null;
		}
		const trimmed = model.trim();
		return isOpenCodeModelSelector(trimmed) ? trimmed : null;
	} catch {
		return null;
	}
}

async function readModelFromConfigFile(filePath: string): Promise<string | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		return extractOpenCodeModelFromConfig(raw);
	} catch {
		return null;
	}
}

/**
 * Explicit model resolution for OpenCode cards (AA-O1a).
 *
 * Order: an operator-set `KANBAN_OPENCODE_MODEL`, then the model the user
 * selected in their own OpenCode configuration, then nothing at all so
 * OpenCode applies its own default. Kanban never searches credential stores or
 * prefers a hosted provider: an unrequested cloud model would quietly bill a
 * different provider than the one the local-Qwen design assumes.
 */
export async function resolveOpenCodeModelSelection(options: {
	cwd: string;
	env?: Record<string, string | undefined>;
}): Promise<OpenCodeModelSelection> {
	const requested = readEnvValue(options.env, KANBAN_OPENCODE_MODEL_ENV);
	if (requested) {
		if (isOpenCodeModelSelector(requested)) {
			return { model: requested, source: "kanban-env", configPath: null, warning: null };
		}
		return {
			model: null,
			source: "invalid",
			configPath: null,
			warning:
				`${KANBAN_OPENCODE_MODEL_ENV}="${requested}" is not provider/model, so Kanban left the ` +
				"model to OpenCode instead of guessing one.",
		};
	}
	const candidates = getOpenCodeConfigPathCandidates(options);
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const model = await readModelFromConfigFile(candidates[index] as string);
		if (model) {
			return { model, source: "agent-config", configPath: (candidates[index] as string) ?? null, warning: null };
		}
	}
	return { model: null, source: "none", configPath: null, warning: null };
}
