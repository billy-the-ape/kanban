import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { KANBAN_OPENCODE_MODEL_ENV, OPENCODE_PINNED_VERSION } from "../../../src/terminal/opencode-integration";

const originalHome = process.env.HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
const originalOpenCodeModel = process.env[KANBAN_OPENCODE_MODEL_ENV];
let tempHome: string | null = null;
const tempDirectories: string[] = [];
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function setKanbanProcessContext(): void {
	process.argv = ["node", "/Users/example/repo/dist/cli.js"];
	process.execArgv = [];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: "/usr/local/bin/node",
	});
}

function getCliFlagValue(args: string[], flag: string): string | null {
	const index = args.indexOf(flag);
	return index >= 0 ? (args[index + 1] ?? null) : null;
}

/**
 * An empty workspace, so OpenCode model discovery cannot pick up a stray
 * `opencode.json` left in a shared directory by another suite.
 */
function setupEmptyWorkspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "kanban-opencode-workspace-"));
	tempDirectories.push(directory);
	return directory;
}

/**
 * An executable stand-in for the pinned OpenCode CLI (AA-O1). Passing the bare
 * `opencode` instead would make every OpenCode test run whatever this machine
 * has on PATH: the compatibility probe and the exact-session probe both consult
 * it, and `opencode session list` prints nothing for a project with no
 * sessions, so a resume test that passes on a machine without OpenCode fails on
 * one that has it. The script answers both probes for the pinned release, and
 * only the session ids a test names.
 */
function setupOpenCodeCliFixture(options: { sessions?: string[] } = {}): string {
	const directory = mkdtempSync(join(tmpdir(), "kanban-opencode-cli-"));
	tempDirectories.push(directory);
	const sessions = options.sessions ?? [];
	const script = [
		"#!/bin/sh",
		'if [ "$1" = "--version" ]; then',
		`  echo "${OPENCODE_PINNED_VERSION}"`,
		"  exit 0",
		"fi",
		'if [ "$1" = "session" ]; then',
		...(sessions.length > 0 ? sessions.map((id) => `  echo "${id}  Kanban session  2m"`) : ["  :"]),
		"  exit 0",
		"fi",
		"exit 0",
	].join("\n");
	const scriptPath = join(directory, "opencode");
	writeFileSync(scriptPath, `${script}\n`, { mode: 0o755 });
	return scriptPath;
}

/**
 * AA-S1: generated integration resources are scoped by workspace, task and
 * launch attempt, so a test resolves them from what the adapter handed the
 * agent rather than from a machine-shared path. This asserts the file sits in
 * `<home>/.cline/kanban/hooks/<agent>/<workspace>/<task>/<attempt>/`.
 */
function expectAttemptScopedDirectory(
	directoryValue: string | null | undefined,
	agentDir: string,
	scope: { workspaceId: string; taskId: string; attemptId: string },
): string {
	if (!directoryValue) {
		throw new Error(`expected a generated resource below hooks/${agentDir}`);
	}
	const relativePath = relative(join(homedir(), ".cline", "kanban", "hooks", agentDir), directoryValue);
	expect(relativePath.startsWith("..") || isAbsolute(relativePath)).toBe(false);
	const scopeSegments = relativePath.split(sep).filter((segment) => segment.length > 0);
	// Each segment is `<readable>-<hash>`, so the readable prefix is compared.
	expect(scopeSegments).toEqual([
		expect.stringContaining(`${scope.workspaceId}-`),
		expect.stringContaining(`${scope.taskId}-`),
		expect.stringContaining(`${scope.attemptId}-`),
	]);
	return directoryValue;
}

/** Same check for a generated file written inside the attempt directory. */
function expectAttemptScopedPath(
	pathValue: string | null | undefined,
	agentDir: string,
	scope: { workspaceId: string; taskId: string; attemptId: string },
): string {
	if (!pathValue) {
		throw new Error(`expected a generated resource below hooks/${agentDir}`);
	}
	expectAttemptScopedDirectory(dirname(pathValue), agentDir, scope);
	return pathValue;
}

function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`)) {
			values.push(arg.slice(key.length + 3));
			continue;
		}
		if (arg.startsWith(`--config=${key}=`)) {
			values.push(arg.slice(key.length + 10));
		}
	}
	return values;
}

// A developer shell that exports any of these changes the generated overlay's
// keys or adds a `--model` flag, so the OpenCode assertions below would be
// testing this machine instead of Kanban. The originals are restored afterwards.
beforeEach(() => {
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.OPENCODE_CONFIG;
	delete process.env[KANBAN_OPENCODE_MODEL_ENV];
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
	if (originalOpenCodeConfig === undefined) {
		delete process.env.OPENCODE_CONFIG;
	} else {
		process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
	}
	if (originalOpenCodeModel === undefined) {
		delete process.env[KANBAN_OPENCODE_MODEL_ENV];
	} else {
		process.env[KANBAN_OPENCODE_MODEL_ENV] = originalOpenCodeModel;
	}
	for (const directory of tempDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	tempDirectories.length = 0;
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
});

describe("prepareAgentLaunch hook strategies", () => {
	it("configures Codex hooks without legacy notify", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("codex-hook");
		expect(launchCommand).toContain("hooks.UserPromptSubmit");
		expect(launchCommand).toContain("hooks.Stop");
		expect(launchCommand).toContain("hooks.PermissionRequest");
		expect(getCodexConfigOverrideValues(launch.args, "features.hooks")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(launch.args, "features.codex_hooks")).toEqual([]);
		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:user_prompt_submit:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:pre_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:post_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('trusted_hash="sha256:');
		expect(launchCommand).toContain("timeout=5");
		expect(launchCommand).not.toContain("codex-wrapper");
		expect(launchCommand).not.toContain("notify=");

		const wrapperPath = join(homedir(), ".cline", "kanban", "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
	});

	it("appends Kanban sidebar instructions for home Claude sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[appendPromptIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[appendPromptIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("appends Kanban sidebar instructions for home Codex sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const developerInstructions = getCodexConfigOverrideValues(launch.args, "developer_instructions");
		expect(developerInstructions).toHaveLength(1);
		expect(developerInstructions[0]).toContain("Kanban sidebar agent");
		expect(developerInstructions[0]).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create");
		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("disables Codex startup update checks for Kanban-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("preserves an explicit Codex update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-update-check",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		expect(launch.env.KANBAN_HOOK_ATTEMPT_ID).toBe("attempt-1");
		const settingsPath = expectAttemptScopedPath(getCliFlagValue(launch.args, "--settings"), "claude", {
			workspaceId: "workspace-1",
			taskId: "task-1",
			attemptId: "attempt-1",
		});
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
	});

	it("writes Gemini settings with AfterTool mapped to to_in_progress", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		const settingsPath = expectAttemptScopedPath(launch.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "gemini", {
			workspaceId: "workspace-1",
			taskId: "task-1",
			attemptId: "attempt-1",
		});
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
		};
		const afterToolCommand = settings.hooks?.AfterTool?.[0]?.hooks?.[0]?.command;
		expect(afterToolCommand).toContain("hooks");
		expect(afterToolCommand).toContain("gemini-hook");
		// The adapter never writes a wrapper script, not even into its own scope.
		expect(existsSync(join(dirname(settingsPath), "gemini-hook.mjs"))).toBe(false);
	});

	it("points OpenCode at a generated overlay plugin without touching user config", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		const configPath = expectAttemptScopedPath(launch.env.OPENCODE_CONFIG, "opencode", {
			workspaceId: "workspace-1",
			taskId: "task-1",
			attemptId: "attempt-1",
		});
		// `OPENCODE_CONFIG` is merged as an extra source by the pinned release, so
		// the overlay only has to add the bridge: it must not carry a model, agent
		// or any other setting that would outrank the user's own configuration.
		const overlay = JSON.parse(readFileSync(configPath, "utf8")) as { plugin?: unknown };
		expect(Object.keys(overlay).sort()).toEqual(["$schema", "plugin"]);
		const pluginDirectory = (overlay.plugin as string[])[0];
		expect(pluginDirectory).toBeTypeOf("string");
		const manifest = JSON.parse(readFileSync(join(pluginDirectory, "package.json"), "utf8")) as {
			type?: string;
			main?: string;
		};
		expect(manifest.type).toBe("module");
		expect(manifest.main).toBe("./index.js");

		const plugin = readFileSync(join(pluginDirectory, "index.js"), "utf8");
		// The events the pinned release actually emits, and nothing else.
		expect(plugin).toContain('"session.idle"');
		expect(plugin).toContain('"session.error"');
		expect(plugin).toContain('"permission.asked"');
		expect(plugin).toContain('"message.part.updated"');
		// AA-O1a: the bridge reports the session id it observed, so a later launch
		// resumes this exact conversation.
		expect(plugin).toContain("--session-id");
		// AA-O1: every ingest call names its source, and that flag is what selects
		// the normalizer reading the bridge's payload keys. Drop it and the assistant
		// text, the approval summary and the tool detail are accepted and discarded.
		expect(plugin.match(/"--source",\s*"opencode"/g)?.length).toBe(3);
		// AA-O1a: approval stays with the human - the bridge never answers a
		// permission, it only parks the card.
		expect(plugin).not.toContain("reply:");
		expect(plugin).not.toContain('"always"');
		// A task launch must not fetch another build behind the version check.
		expect(launch.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
	});

	it("merges a user's own OPENCODE_CONFIG into the launch instead of overwriting it", async () => {
		const homePath = setupTempHome();
		const workspace = setupEmptyWorkspace();
		const userConfigPath = join(homePath, "my-opencode.json");
		writeFileSync(
			userConfigPath,
			JSON.stringify({
				model: "ollama/qwen2.5-coder:32b",
				mcp: { browser: { url: "http://127.0.0.1:9222" } },
				plugin: ["./my-plugin"],
			}),
			"utf8",
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-user-config",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: workspace,
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
			env: { OPENCODE_CONFIG: userConfigPath },
		});

		// Repointing the variable is only safe because the user's own settings ride
		// along in the file it now points at: their model, their MCP servers, and
		// their plugin entry resolved next to the file they wrote it in.
		expect(launch.env.OPENCODE_CONFIG).not.toBe(userConfigPath);
		const overlay = JSON.parse(readFileSync(launch.env.OPENCODE_CONFIG ?? "", "utf8")) as Record<string, unknown>;
		expect(overlay.model).toBe("ollama/qwen2.5-coder:32b");
		expect(overlay.mcp).toEqual({ browser: { url: "http://127.0.0.1:9222" } });
		const pluginEntries = overlay.plugin as string[];
		expect(pluginEntries[0]).toBe(join(homePath, "my-plugin"));
		expect(pluginEntries.at(-1)).toBe(join(dirname(launch.env.OPENCODE_CONFIG ?? ""), "plugin"));
		// The same selection is what the model policy passes, not a guessed one.
		expect(getCliFlagValue(launch.args, "--model")).toBe("ollama/qwen2.5-coder:32b");
		expect(launch.warningMessage).toBeUndefined();
	});

	it("finds an exported OPENCODE_CONFIG even though a task launch carries no env", async () => {
		const homePath = setupTempHome();
		const workspace = setupEmptyWorkspace();
		const userConfigPath = join(homePath, "exported-opencode.json");
		process.env.OPENCODE_CONFIG = userConfigPath;
		writeFileSync(
			userConfigPath,
			JSON.stringify({ model: "ollama/qwen2.5-coder:32b", mcp: { browser: { url: "http://127.0.0.1:9222" } } }),
			"utf8",
		);

		// A real task launch reaches the adapter with no env of its own: the runtime
		// starts terminal sessions without one and the process environment is merged
		// only later, when the PTY is built. Reading just the request env left an
		// exported config unseen, and the launch then repointed the variable at the
		// overlay - dropping the user's providers, agents and MCP servers silently.
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-exported-config",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: workspace,
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		expect(launch.env.OPENCODE_CONFIG).not.toBe(userConfigPath);
		const overlay = JSON.parse(readFileSync(launch.env.OPENCODE_CONFIG ?? "", "utf8")) as Record<string, unknown>;
		expect(overlay.model).toBe("ollama/qwen2.5-coder:32b");
		expect(overlay.mcp).toEqual({ browser: { url: "http://127.0.0.1:9222" } });
		// The bridge still rides along, so the card keeps moving itself to review.
		expect((overlay.plugin as string[]).at(-1)).toBe(join(dirname(launch.env.OPENCODE_CONFIG ?? ""), "plugin"));
		expect(launch.warningMessage).toBeUndefined();
	});

	it("leaves an unmergeable OPENCODE_CONFIG in force and says the bridge is off", async () => {
		const homePath = setupTempHome();
		const workspace = setupEmptyWorkspace();
		const userConfigPath = join(homePath, "opencode.jsonc");
		writeFileSync(userConfigPath, "{ model: local/qwen, }", "utf8");

		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-unreadable-config",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: workspace,
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
			env: { OPENCODE_CONFIG: userConfigPath },
		});

		// Their configuration outranks the bridge: Kanban drops its own hook
		// injection rather than discarding a configuration it was not given. The
		// launch environment is merged over the request environment, so leaving the
		// key unset is what keeps their exported file in force - and the warning
		// explains a card that never moves itself to review.
		expect(launch.env.OPENCODE_CONFIG).toBeUndefined();
		expect(launch.warningMessage ?? "").toContain("without the Kanban bridge");
		expect(launch.warningMessage ?? "").toContain(userConfigPath);
	});

	it("leaves the OpenCode model alone when only state and auth files exist", async () => {
		const homePath = setupTempHome();
		const localAppDataPath = join(homePath, "AppData", "Local");
		process.env.LOCALAPPDATA = localAppDataPath;

		const statePath = join(localAppDataPath, "opencode", "state");
		mkdirSync(statePath, { recursive: true });
		writeFileSync(
			join(statePath, "model.json"),
			JSON.stringify(
				{
					recent: [
						{ providerID: "anthropic", modelID: "claude-3-7-sonnet" },
						{ providerID: "openai", modelID: "gpt-4o" },
					],
				},
				null,
				2,
			),
			"utf8",
		);

		const authPath = join(localAppDataPath, "opencode");
		mkdirSync(authPath, { recursive: true });
		writeFileSync(
			join(authPath, "auth.json"),
			JSON.stringify(
				{
					openai: { key: "sk-test" },
				},
				null,
				2,
			),
			"utf8",
		);

		// AA-O1a: OpenCode's stored model state and credential files are not a
		// selection the user made for this card. Inferring one here used to bill a
		// hosted provider the local model design never chose, so Kanban now leaves
		// the model to OpenCode instead of guessing.
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-model",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: setupEmptyWorkspace(),
			prompt: "",
		});

		expect(launch.args).not.toContain("--model");

		// The assertion above only means something next to its positive control: a
		// selection the user really made has to add the flag, otherwise the check
		// would pass on a suite whose model wiring never ran at all.
		process.env.XDG_CONFIG_HOME = join(homePath ?? "/tmp", ".config");
		const configDir = join(homePath ?? "/tmp", ".config", "opencode");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ model: "local/qwen3-coder" }, null, 2), "utf8");
		const selected = await prepareAgentLaunch({
			taskId: "task-opencode-model-selected",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: setupEmptyWorkspace(),
			prompt: "",
		});
		expect(getCliFlagValue(selected.args, "--model")).toBe("local/qwen3-coder");
	});

	it("passes an explicit OpenCode model selection and nothing invented", async () => {
		setupTempHome();
		const homePath = process.env.HOME;
		const workspaceDir = setupEmptyWorkspace();
		const configDir = join(homePath ?? "/tmp", ".config", "opencode");
		// The variable outranks the `~/.config` default, so the test pins it to the
		// temp home instead of the machine's real config directory.
		process.env.XDG_CONFIG_HOME = join(homePath ?? "/tmp", ".config");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "opencode.json"),
			JSON.stringify({ model: "openrouter/anthropic/claude-sonnet-4.5" }, null, 2),
			"utf8",
		);

		const fromAgentConfig = await prepareAgentLaunch({
			taskId: "task-opencode-config-model",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: workspaceDir,
			prompt: "",
		});
		// A model the user selected in their own OpenCode config is honored as-is.
		expect(getCliFlagValue(fromAgentConfig.args, "--model")).toBe("openrouter/anthropic/claude-sonnet-4.5");

		// An operator override outranks it, so a fleet can pin a local endpoint.
		const override = await prepareAgentLaunch({
			taskId: "task-opencode-env-model",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: workspaceDir,
			prompt: "",
			env: { KANBAN_OPENCODE_MODEL: "local/qwen3-coder" },
		});
		expect(getCliFlagValue(override.args, "--model")).toBe("local/qwen3-coder");

		// A malformed override is reported, not repaired: falling back to a
		// guessed provider is exactly what the AA-O1a policy refuses to do.
		const invalid = await prepareAgentLaunch({
			taskId: "task-opencode-invalid-model",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: workspaceDir,
			prompt: "",
			env: { KANBAN_OPENCODE_MODEL: "qwen3-coder" },
		});
		expect(invalid.args).not.toContain("--model");
		expect(invalid.warningMessage ?? "").toContain("KANBAN_OPENCODE_MODEL");
		expect(invalid.warningMessage ?? "").toContain("not provider/model");

		// A user-supplied flag always wins over anything Kanban would add.
		const explicit = await prepareAgentLaunch({
			taskId: "task-opencode-explicit-model",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: ["--model", "own/provider-model"],
			cwd: workspaceDir,
			prompt: "",
			env: { KANBAN_OPENCODE_MODEL: "local/qwen3-coder" },
		});
		expect(getCliFlagValue(explicit.args, "--model")).toBe("own/provider-model");
	});

	it("writes Droid settings with hook transitions and runtime autonomy mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const settingsArgIndex = launch.args.indexOf("--settings");
		expect(settingsArgIndex).toBeGreaterThanOrEqual(0);
		const settingsPath = launch.args[settingsArgIndex + 1];
		expect(settingsPath).toBeDefined();
		expectAttemptScopedPath(settingsPath, "droid", {
			workspaceId: "workspace-1",
			taskId: "task-1",
			attemptId: "attempt-1",
		});

		const settings = JSON.parse(readFileSync(settingsPath ?? "", "utf8")) as {
			autonomyMode?: string;
			hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
		};
		expect(settings.autonomyMode).toBe("auto-high");
		expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.Notification?.[0]?.hooks?.[0]?.command).toContain("activity");
		expect(settings.hooks?.Notification?.[1]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const preToolInProgressHook = settings.hooks?.PreToolUse?.find(
			(hook) => hook.matcher === "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create",
		);
		expect(preToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		const preToolReviewHook = settings.hooks?.PreToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(preToolReviewHook?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const postToolInProgressHook = settings.hooks?.PostToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(postToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("to_in_progress");
	});

	it("writes Kiro agent hooks and uses a Kanban-managed soft planning prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kiro-1",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Investigate deployment drift",
			startInPlanMode: true,
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-kiro-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.env.KANBAN_HOOK_ATTEMPT_ID).toBe("attempt-1");
		expect(launch.args).toContain("--agent");
		// Kiro owns the agent-file directory, so the generated definition is
		// named per task instead of shared under a fixed name (AA-S1).
		const agentName = getCliFlagValue(launch.args, "--agent");
		expect(agentName).not.toBe("kanban");
		expect(agentName ?? "").toContain("task-kiro-1-");
		expect(launch.args).toContain("--trust-all-tools");
		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Do not modify files");
		expect(initialPrompt).toContain("Task:\nInvestigate deployment drift");

		const configPath = join(homedir(), ".kiro", "agents", `${agentName}.json`);
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			tools?: string[];
			hooks?: Record<string, Array<{ command?: string }>>;
		};
		expect(config.tools).toEqual(["*"]);
		expect(config.hooks?.agentSpawn?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.userPromptSubmit?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.preToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.preToolUse?.[1]?.command).toContain("to_in_progress");
		expect(config.hooks?.postToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.stop?.[0]?.command).toContain("to_review");
		expect(config.hooks?.stop?.[0]?.command).toContain("Waiting for review");
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("defers Codex plan-mode startup input until startup UI is ready", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("Audit the deployment pipeline");
		expect(launch.deferredStartupInput).toContain("\u001b[200~");
		expect(launch.deferredStartupInput).toContain("/plan Audit the deployment pipeline");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("defers a bare /plan command when Codex plan mode has no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan-empty",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});

		expect(launch.deferredStartupInput).toContain("/plan");
		expect(launch.deferredStartupInput).not.toContain("/plan ");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("writes Cline hook scripts and injects --hooks-dir", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});

		const hooksDir = expectAttemptScopedDirectory(getCliFlagValue(launch.args, "--hooks-dir"), "cline", {
			workspaceId: "workspace-1",
			taskId: "task-1",
			attemptId: "attempt-1",
		});
		const notificationHookPath =
			process.platform === "win32" ? join(hooksDir, "Notification.ps1") : join(hooksDir, "Notification");
		const taskCompleteHookPath =
			process.platform === "win32" ? join(hooksDir, "TaskComplete.ps1") : join(hooksDir, "TaskComplete");
		const userPromptSubmitHookPath =
			process.platform === "win32" ? join(hooksDir, "UserPromptSubmit.ps1") : join(hooksDir, "UserPromptSubmit");
		const preToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PreToolUse.ps1") : join(hooksDir, "PreToolUse");
		const postToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PostToolUse.ps1") : join(hooksDir, "PostToolUse");

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const hooksDirArgIndex = launch.args.indexOf("--hooks-dir");
		expect(hooksDirArgIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[hooksDirArgIndex + 1]).toBe(hooksDir);

		expect(existsSync(notificationHookPath)).toBe(true);
		expect(existsSync(taskCompleteHookPath)).toBe(true);
		expect(existsSync(userPromptSubmitHookPath)).toBe(true);
		expect(existsSync(preToolUseHookPath)).toBe(true);
		expect(existsSync(postToolUseHookPath)).toBe(true);

		const notificationScript = readFileSync(notificationHookPath, "utf8");
		expect(notificationScript).toContain("hooks");
		expect(notificationScript).toContain("to_review");
		expect(notificationScript).toContain("user_attention");
		expect(notificationScript).toContain("completion_result");
		expect(notificationScript).toContain('{"cancel":false}');

		const taskCompleteScript = readFileSync(taskCompleteHookPath, "utf8");
		expect(taskCompleteScript).toContain("hooks");
		expect(taskCompleteScript).toContain("to_review");
		expect(taskCompleteScript).toContain('{"cancel":false}');

		const userPromptSubmitScript = readFileSync(userPromptSubmitHookPath, "utf8");
		expect(userPromptSubmitScript).toContain("hooks");
		expect(userPromptSubmitScript).toContain("to_in_progress");
		expect(userPromptSubmitScript).toContain('{"cancel":false}');

		const preToolUseScript = readFileSync(preToolUseHookPath, "utf8");
		expect(preToolUseScript).toContain("hooks");
		expect(preToolUseScript).toContain("activity");
		expect(preToolUseScript).toContain("to_in_progress");
		expect(preToolUseScript).toContain("to_review");
		expect(preToolUseScript).toContain("ask_followup_question");
		expect(preToolUseScript).toContain("plan_mode_respond");

		const postToolUseScript = readFileSync(postToolUseHookPath, "utf8");
		expect(postToolUseScript).toContain("hooks");
		expect(postToolUseScript).toContain("activity");
		expect(postToolUseScript).toContain("to_in_progress");
		expect(postToolUseScript).toContain("ask_followup_question");
		expect(postToolUseScript).toContain("plan_mode_respond");
	});

	it("scopes generated agent resources to one launch attempt and removes them on teardown", async () => {
		setupTempHome();
		const firstAttempt = await prepareAgentLaunch({
			taskId: "task-scope",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
		});
		const secondAttempt = await prepareAgentLaunch({
			taskId: "task-scope",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			// A restart of the same card mints a fresh token, so the previous
			// attempt's generated files are never re-read or overwritten.
			attemptId: "attempt-2",
		});

		const firstSettingsPath = getCliFlagValue(firstAttempt.args, "--settings");
		const secondSettingsPath = getCliFlagValue(secondAttempt.args, "--settings");
		if (!firstSettingsPath || !secondSettingsPath) {
			throw new Error("expected both Claude launches to pass --settings");
		}
		expect(firstSettingsPath).not.toBe(secondSettingsPath);
		expect(existsSync(firstSettingsPath)).toBe(true);
		expect(existsSync(secondSettingsPath)).toBe(true);

		// Tearing down one attempt only removes that attempt's directory.
		await firstAttempt.cleanup?.();
		expect(existsSync(firstSettingsPath)).toBe(false);
		expect(existsSync(secondSettingsPath)).toBe(true);
	});

	it("gives two parallel tasks in one workspace their own resources and tokens", async () => {
		setupTempHome();
		const [left, right] = await Promise.all([
			prepareAgentLaunch({
				taskId: "task-left",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp",
				prompt: "",
				workspaceId: "workspace-1",
				attemptId: "attempt-left",
			}),
			prepareAgentLaunch({
				taskId: "task-right",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp",
				prompt: "",
				workspaceId: "workspace-1",
				attemptId: "attempt-right",
			}),
		]);

		expect(left.env.KANBAN_HOOK_ATTEMPT_ID).toBe("attempt-left");
		expect(right.env.KANBAN_HOOK_ATTEMPT_ID).toBe("attempt-right");

		const leftSettingsPath = expectAttemptScopedPath(getCliFlagValue(left.args, "--settings"), "claude", {
			workspaceId: "workspace-1",
			taskId: "task-left",
			attemptId: "attempt-left",
		});
		const rightSettingsPath = expectAttemptScopedPath(getCliFlagValue(right.args, "--settings"), "claude", {
			workspaceId: "workspace-1",
			taskId: "task-right",
			attemptId: "attempt-right",
		});
		expect(leftSettingsPath).not.toBe(rightSettingsPath);
		expect(existsSync(leftSettingsPath)).toBe(true);
		expect(existsSync(rightSettingsPath)).toBe(true);
	});

	it("keeps workspace-less sessions on the shared agent directory without an attempt token", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			attemptId: "attempt-home",
		});

		// The home agent never addressed a generated file, so it keeps the
		// pre-AA-S1 behaviour: no hook environment and nothing to clean up.
		expect(launch.env.KANBAN_HOOK_ATTEMPT_ID).toBeUndefined();
		expect(launch.env.KANBAN_HOOK_TASK_ID).toBeUndefined();
		expect(launch.cleanup).toBeUndefined();
		expect(launch.args).not.toContain("--settings");
	});

	it("adds resume flags for each agent", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(geminiLaunch.args).toEqual(expect.arrayContaining(["--resume", "latest"]));

		// AA-O1a: OpenCode is refused rather than pointed at whichever session it
		// touched last, which could be another card's conversation. Exact resume
		// with a recorded session id is covered by its own test below.
		await expect(
			prepareAgentLaunch({
				taskId: "task-opencode",
				agentId: "opencode",
				binary: setupOpenCodeCliFixture(),
				args: [],
				cwd: "/tmp",
				prompt: "",
				resumeFromTrash: true,
			}),
		).rejects.toThrow(/Start a new OpenCode session/);

		const droidLaunch = await prepareAgentLaunch({
			taskId: "task-droid",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(droidLaunch.args).toContain("--resume");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(kiroLaunch.args).toContain("--resume");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(clineLaunch.args).toContain("--continue");
	});

	it("resumes the OpenCode session Kanban recorded for the card", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-resume",
			agentId: "opencode",
			// The fixture lists this id, so the exact-session probe answers "it exists"
			// here instead of asking this machine's OpenCode about an empty project.
			binary: setupOpenCodeCliFixture({ sessions: ["ses_08f7c2a9b1eF4d"] }),
			args: [],
			cwd: setupEmptyWorkspace(),
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
			externalSessionId: "ses_08f7c2a9b1eF4d",
		});
		// AA-O1a: the pinned release takes an exact session, so a resumed card
		// names its own conversation instead of the most recent one.
		expect(getCliFlagValue(launch.args, "--session")).toBe("ses_08f7c2a9b1eF4d");
		expect(launch.args).not.toContain("--continue");
		// The bridge pins the same session instead of adopting the first it sees.
		expect(launch.env.KANBAN_OPENCODE_SESSION_ID).toBe("ses_08f7c2a9b1eF4d");
	});
	it("refuses to resume an OpenCode session the CLI does not list", async () => {
		setupTempHome();
		// The counterpart of the test above, which is what makes it meaningful: the
		// listing here omits the recorded id, so a launch that never consulted the
		// probe would happily resume whichever session OpenCode touched last.
		await expect(
			prepareAgentLaunch({
				taskId: "task-opencode-resume-missing",
				agentId: "opencode",
				binary: setupOpenCodeCliFixture(),
				args: [],
				cwd: setupEmptyWorkspace(),
				prompt: "",
				resumeFromTrash: true,
				workspaceId: "workspace-1",
				attemptId: "attempt-1",
				externalSessionId: "ses_08f7c2a9b1eF4d",
			}),
		).rejects.toThrow(/is not available in this workspace/);
	});
	it("keeps a recorded session id from pinning a fresh OpenCode launch", async () => {
		setupTempHome();
		// A card that already reported a session can be launched again without a
		// resume (start over, or relaunch after the process exited). OpenCode opens a
		// new conversation there, so a bridge pinned to the old id would reject every
		// event from the session actually running and strand the card in running.
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-fresh",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			cwd: setupEmptyWorkspace(),
			prompt: "",
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
			externalSessionId: "ses_08f7c2a9b1eF4d",
		});
		expect(launch.args).not.toContain("--session");
		// Unpinned, the bridge adopts the new session and reports its id, which is
		// what the next resume needs.
		expect(launch.env.KANBAN_OPENCODE_SESSION_ID).toBeUndefined();
	});

	it("drops --continue from an OpenCode command saved before exact resume", async () => {
		setupTempHome();
		const prompt = "Fix the flaky test\nand keep the unicode ✓";
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-continue",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: ["--continue", "--model", "local/qwen3-coder"],
			cwd: setupEmptyWorkspace(),
			prompt,
		});
		expect(launch.args).not.toContain("--continue");
		// The card still launches, so the removal has to be visible to the user.
		expect(launch.warningMessage ?? "").toContain("--continue");
		// One argv element keeps a multi-line prompt from being re-split by a shell.
		expect(launch.args.at(-1)).toBe(prompt);
		expect(launch.args[launch.args.length - 2]).toBe("--prompt");
	});

	it("drops --continue from a resumed OpenCode command too", async () => {
		setupTempHome();
		// A command saved before AA-O1 carries `--continue` into a resume as well,
		// where it would sit next to the exact session this launch pins and leave it
		// to the CLI to decide which one wins.
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-resume-continue",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture({ sessions: ["ses_08f7c2a9b1eF4d"] }),
			args: ["--continue"],
			cwd: setupEmptyWorkspace(),
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
			attemptId: "attempt-1",
			externalSessionId: "ses_08f7c2a9b1eF4d",
		});
		expect(launch.args).not.toContain("--continue");
		expect(getCliFlagValue(launch.args, "--session")).toBe("ses_08f7c2a9b1eF4d");
		expect(launch.warningMessage ?? "").toContain("--continue");
	});

	it("passes OpenCode planning and autonomy as documented flags", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-flags",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: [],
			autonomousModeEnabled: true,
			startInPlanMode: true,
			cwd: setupEmptyWorkspace(),
			prompt: "",
		});
		expect(getCliFlagValue(launch.args, "--agent")).toBe("plan");
		expect(launch.args.filter((arg) => arg === "--auto")).toHaveLength(1);

		// A flag the user already put in the command wins, and is never duplicated.
		const user = await prepareAgentLaunch({
			taskId: "task-opencode-user-flags",
			agentId: "opencode",
			binary: setupOpenCodeCliFixture(),
			args: ["--agent", "build", "--auto"],
			startInPlanMode: true,
			autonomousModeEnabled: true,
			cwd: setupEmptyWorkspace(),
			prompt: "",
		});
		expect(getCliFlagValue(user.args, "--agent")).toBe("build");
		expect(user.args.filter((arg) => arg === "--auto")).toHaveLength(1);
	});

	it("refuses an OpenCode release Kanban has no contract for", async () => {
		setupTempHome();
		// The version probe runs the requested binary, so a fixture script stands in
		// for an old release instead of depending on what this machine has installed.
		const workspaceDir = setupEmptyWorkspace();
		const fixturePath = join(workspaceDir, "opencode-old.sh");
		writeFileSync(fixturePath, "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
		await expect(
			prepareAgentLaunch({
				taskId: "task-opencode-old",
				agentId: "opencode",
				binary: fixturePath,
				args: [],
				cwd: workspaceDir,
				prompt: "",
			}),
		).rejects.toThrow(/too old for Kanban/);
	});

	it("places Codex hook config before the resume subcommand", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		for (const key of [
			"features.hooks",
			"hooks.state",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.PermissionRequest",
			"hooks.PreToolUse",
			"hooks.PostToolUse",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
	});

	it("applies autonomous mode flags in adapters for non-droid CLIs", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		const permissionModeIndex = claudeLaunch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(claudeLaunch.args[permissionModeIndex + 1]).toBe("auto");
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");
		expect(claudeLaunch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-auto",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-auto",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");
	});

	it("does not add a Claude permission mode when args already set one", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-explicit-mode",
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "acceptEdits"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(launch.args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
		expect(launch.args).not.toContain("auto");
	});

	it("starts Claude plan mode without bypass flags and keeps auto mode reachable", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		expect(launch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
	});

	it("strips an explicit Claude bypass arg in plan mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan-bypass",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-no-auto",
			agentId: "gemini",
			binary: "gemini",
			args: ["--yolo"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-no-auto",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve-all"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-no-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat", "--trust-all-tools"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");
	});
});
