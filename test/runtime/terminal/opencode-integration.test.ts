import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildOpenCodeOverlayConfigContent,
	buildOpenCodePluginManifestContent,
	describeOpenCodeCompatibility,
	extractOpenCodeModelFromConfig,
	formatOpenCodeVersion,
	getOpenCodeConfigLocationHints,
	getOpenCodeConfigPathCandidates,
	getOpenCodeOverlayLayout,
	isOpenCodeModelSelector,
	isOpenCodeSessionSelector,
	isOpenCodeVersionSupported,
	KANBAN_OPENCODE_MODEL_ENV,
	OPENCODE_MINIMUM_VERSION,
	OPENCODE_PINNED_VERSION,
	parseOpenCodeVersion,
	probeOpenCodeVersion,
	resolveOpenCodeModelSelection,
	stripJsonComments,
	verifyOpenCodeSession,
} from "../../../src/terminal/opencode-integration";

const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let tempHome: string | null = null;
let tempWorkspace: string | null = null;

function setupTempPaths(): { home: string; workspace: string } {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-opencode-home-"));
	tempWorkspace = mkdtempSync(join(tmpdir(), "kanban-opencode-workspace-"));
	process.env.HOME = tempHome;
	// The XDG variable outranks the `~/.config` default, so a suite that exercises
	// configuration discovery has to control it as well.
	delete process.env.XDG_CONFIG_HOME;
	return { home: tempHome, workspace: tempWorkspace };
}

/** Writes an executable stand-in for one OpenCode subcommand. */
function writeFixtureScript(name: string, body: string): string {
	const workspace = tempWorkspace ?? setupTempPaths().workspace;
	const scriptPath = join(workspace, name);
	writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return scriptPath;
}

function writeConfigFile(filePath: string, content: string): string {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
	return filePath;
}

beforeEach(() => {
	setupTempPaths();
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (tempWorkspace) {
		rmSync(tempWorkspace, { recursive: true, force: true });
		tempWorkspace = null;
	}
});

describe("OpenCode version contract (AA-O1)", () => {
	it("pins a released version and a minimum that matches it", () => {
		expect(parseOpenCodeVersion(OPENCODE_PINNED_VERSION)).not.toBeNull();
		expect(formatOpenCodeVersion(OPENCODE_MINIMUM_VERSION)).toBe("1.19.0");
		expect(isOpenCodeVersionSupported(parseOpenCodeVersion(OPENCODE_PINNED_VERSION))).toBe(true);
	});

	it("reads the version out of real CLI output shapes", () => {
		expect(formatOpenCodeVersion(parseOpenCodeVersion("1.19.6"))).toBe("1.19.6");
		expect(formatOpenCodeVersion(parseOpenCodeVersion("opencode/1.20.1 linux/x64"))).toBe("1.20.1");
		expect(formatOpenCodeVersion(parseOpenCodeVersion("  v2.0.0 \n"))).toBe("2.0.0");
		expect(parseOpenCodeVersion("opencode: command not found")).toBeNull();
		expect(parseOpenCodeVersion(null)).toBeNull();
	});

	it("allows the supported range and names the fix for an old release", () => {
		expect(isOpenCodeVersionSupported({ major: 1, minor: 19, patch: 0 })).toBe(true);
		expect(isOpenCodeVersionSupported({ major: 1, minor: 20, patch: 0 })).toBe(true);
		expect(isOpenCodeVersionSupported({ major: 2, minor: 0, patch: 0 })).toBe(true);
		expect(isOpenCodeVersionSupported({ major: 1, minor: 18, patch: 99 })).toBe(false);
		// An unreadable version must not hide a working CLI behind a false block.
		expect(isOpenCodeVersionSupported(null)).toBe(true);

		const current = describeOpenCodeCompatibility("1.19.6");
		expect(current.status).toBe("supported");
		expect(current.remediation).toBeNull();

		const unknown = describeOpenCodeCompatibility("not a version");
		expect(unknown.status).toBe("unknown");
		expect(unknown.remediation).toBeNull();

		const old = describeOpenCodeCompatibility("1.2.3");
		expect(old.status).toBe("unsupported");
		expect(old.remediation ?? "").toContain("too old for Kanban");
		expect(old.remediation ?? "").toContain(OPENCODE_PINNED_VERSION);
	});

	it("asks the CLI itself instead of trusting an installed path", async () => {
		const reporting = writeFixtureScript("opencode-version.sh", 'echo "opencode/1.19.6 linux/x64"');
		expect(formatOpenCodeVersion(await probeOpenCodeVersion(reporting, { cwd: tempWorkspace ?? "" }))).toBe("1.19.6");

		// A missing binary reports "unknown" rather than a fake version, so the
		// adapter keeps the card visible with install guidance.
		expect(await probeOpenCodeVersion("opencode-that-does-not-exist", { cwd: tempWorkspace ?? "" })).toBeNull();
	});
});

describe("OpenCode selectors (AA-O1a)", () => {
	it("accepts provider-qualified models and rejects bare names", () => {
		expect(isOpenCodeModelSelector("local/qwen3-coder")).toBe(true);
		// OpenRouter model ids keep their own provider segment, so the selector
		// cannot stop at the first slash.
		expect(isOpenCodeModelSelector("openrouter/anthropic/claude-sonnet-4.5")).toBe(true);
		// Ollama tags a model with a colon, and the tag is part of the id.
		expect(isOpenCodeModelSelector("ollama/qwen2.5-coder:32b")).toBe(true);
		expect(isOpenCodeModelSelector("anthropic/claude-3-7-sonnet#thinking")).toBe(true);
		expect(isOpenCodeModelSelector("qwen3-coder")).toBe(false);
		expect(isOpenCodeModelSelector("local/")).toBe(false);
		// Never handed to the CLI, even as the value of a flag.
		expect(isOpenCodeModelSelector("--session=ses_x1y2z3")).toBe(false);
		expect(isOpenCodeModelSelector("")).toBe(false);
	});

	it("accepts session ids in the shape the CLI prints", () => {
		expect(isOpenCodeSessionSelector("ses_08f7c2a9b1eF4d")).toBe(true);
		expect(isOpenCodeSessionSelector("ses_08f7c2a9b1eF4d ".trim())).toBe(true);
		// Too short to be a real id, or shaped like a shell metacharacter bag.
		expect(isOpenCodeSessionSelector("ses_x")).toBe(false);
		expect(isOpenCodeSessionSelector("ses_08f7; rm -rf /")).toBe(false);
	});
});

describe("OpenCode configuration discovery (AA-O1a)", () => {
	it("reads configuration only, never credentials or model state", () => {
		const home = process.env.HOME ?? "";
		const workspace = tempWorkspace ?? "";
		const candidates = getOpenCodeConfigPathCandidates({ cwd: workspace, env: {} });
		expect(candidates).toContain(join(home, ".config", "opencode", "opencode.json"));
		expect(candidates).toContain(join(tempWorkspace ?? "", "opencode.json"));
		expect(candidates).toContain(join(tempWorkspace ?? "", ".opencode", "opencode.jsonc"));
		// An explicit file sorts first and the project file last, so the loop that
		// walks the list in reverse honors the most local selection.
		const withOverride = getOpenCodeConfigPathCandidates({
			cwd: tempWorkspace ?? "",
			env: { OPENCODE_CONFIG: join(home, "custom.json") },
		});
		expect(withOverride[0]).toBe(join(home, "custom.json"));
		expect(withOverride.at(-1)).toBe(join(tempWorkspace ?? "", ".opencode", "opencode.jsonc"));
		// Credentials live in the auth store and model catalogs in state: neither
		// is a model the user selected for this card.
		expect(candidates.some((candidate) => candidate.includes("auth"))).toBe(false);
		expect(candidates.some((candidate) => candidate.includes("state"))).toBe(false);

		const hints = getOpenCodeConfigLocationHints({ cwd: tempWorkspace ?? "", env: {} });
		expect(hints[0]).toContain(join("opencode", "opencode.json"));
		expect(hints.some((hint) => hint.includes("auth"))).toBe(false);
	});

	it("parses JSONC configuration the way OpenCode writes it", () => {
		expect(extractOpenCodeModelFromConfig('{"model": "local/qwen3-coder"}')).toBe("local/qwen3-coder");
		expect(
			extractOpenCodeModelFromConfig(`{
	// the model I picked for local runs
	"model": "ollama/qwen2.5-coder:32b",
	"theme": "kanban", // trailing content
}`),
		).toBe("ollama/qwen2.5-coder:32b");
		expect(extractOpenCodeModelFromConfig("{ model: local/qwen, }")).toBeNull();
		expect(extractOpenCodeModelFromConfig('{"model": "qwen3-coder"}')).toBeNull();
		expect(extractOpenCodeModelFromConfig("[]")).toBeNull();
		expect(stripJsonComments('{"a":"// not a comment"}')).toBe('{"a":"// not a comment"}');
	});

	it("prefers the operator override, then the user config, then nothing", async () => {
		const home = process.env.HOME ?? "";
		const workspace = tempWorkspace ?? "";
		writeConfigFile(
			join(home, ".config", "opencode", "opencode.json"),
			'{"model":"openrouter/anthropic/claude-sonnet-4.5"}',
		);
		const globalOnly = await resolveOpenCodeModelSelection({ cwd: workspace, env: {} });
		expect(globalOnly).toEqual({
			model: "openrouter/anthropic/claude-sonnet-4.5",
			source: "agent-config",
			configPath: join(home, ".config", "opencode", "opencode.json"),
			warning: null,
		});

		// A project file outranks the global one, matching OpenCode's own merge.
		writeConfigFile(join(workspace, "opencode.json"), '{"model":"ollama/qwen2.5-coder:32b"}');
		const projectWins = await resolveOpenCodeModelSelection({ cwd: workspace, env: {} });
		expect(projectWins.model).toBe("ollama/qwen2.5-coder:32b");

		const override = await resolveOpenCodeModelSelection({
			cwd: workspace,
			env: { [KANBAN_OPENCODE_MODEL_ENV]: "local/qwen3-coder" },
		});
		expect(override.source).toBe("kanban-env");
		expect(override.model).toBe("local/qwen3-coder");

		// A value Kanban cannot vouch for is reported, and the model is left to
		// OpenCode rather than guessed.
		const invalid = await resolveOpenCodeModelSelection({
			cwd: workspace,
			env: { [KANBAN_OPENCODE_MODEL_ENV]: "qwen3-coder" },
		});
		expect(invalid.model).toBeNull();
		expect(invalid.source).toBe("invalid");
		expect(invalid.warning ?? "").toContain(KANBAN_OPENCODE_MODEL_ENV);

		// With every selection removed Kanban adds no flag: silently switching to
		// a hosted provider is exactly what the policy forbids.
		rmSync(join(workspace, "opencode.json"));
		rmSync(join(home, ".config", "opencode", "opencode.json"));
		const withoutConfig = await resolveOpenCodeModelSelection({ cwd: workspace, env: {} });
		expect(withoutConfig.model).toBeNull();
		expect(withoutConfig.source).toBe("none");
		expect(withoutConfig.warning).toBeNull();
	});

	it("never reads a model out of the auth store or state directory", async () => {
		const home = process.env.HOME ?? "";
		writeConfigFile(join(home, ".config", "opencode", "auth.json"), '{"openai":{"key":"sk-test"}}');
		writeConfigFile(
			join(home, ".local", "share", "opencode", "state", "model.json"),
			'{"recent":[{"providerID":"openai","modelID":"gpt-4o"}]}',
		);
		const selection = await resolveOpenCodeModelSelection({ cwd: tempWorkspace ?? "", env: {} });
		expect(selection.model).toBeNull();
		expect(selection.source).toBe("none");
	});
});

describe("OpenCode launch overlay (AA-O1)", () => {
	it("lays out one plugin directory per launch attempt", () => {
		const layout = getOpenCodeOverlayLayout(join(tempHome ?? "", "attempt"));
		expect(layout.configPath).toBe(join(tempHome ?? "", "attempt", "opencode.json"));
		expect(layout.pluginDirectory).toBe(join(tempHome ?? "", "attempt", "plugin"));
		expect(layout.entryPointPath).toBe(join(tempHome ?? "", "attempt", "plugin", "index.js"));
		expect(layout.manifestPath).toBe(join(tempHome ?? "", "attempt", "plugin", "package.json"));
	});

	it("writes only the settings the pinned release understands", () => {
		const layout = getOpenCodeOverlayLayout(join(tempHome ?? "", "attempt"));
		const overlay = JSON.parse(buildOpenCodeOverlayConfigContent(layout)) as Record<string, unknown>;
		// The pinned release reads `plugin`; the newer `plugins` key is dropped as
		// an unsupported setting, so emitting both would fight the schema.
		expect(Object.keys(overlay).sort()).toEqual(["$schema", "plugin"]);
		expect(overlay.plugin).toEqual([layout.pluginDirectory]);

		const manifest = JSON.parse(buildOpenCodePluginManifestContent()) as Record<string, unknown>;
		// The generated entry point uses `export default`, so the directory is only
		// importable as an ES module when the manifest says so.
		expect(manifest.type).toBe("module");
		expect(manifest.main).toBe("./index.js");
		expect(manifest.private).toBe(true);
	});
});

describe("OpenCode session probe (AA-O1a)", () => {
	it("confirms a session exists in this workspace without guessing", async () => {
		const listPath = writeFixtureScript(
			"opencode-sessions.sh",
			'echo "ses_08f7c2a9b1eF4d  Implement retry logic  2m"\necho "ses_9d8c7b6a5f4e  Refactor parser  1h"',
		);
		const options = { binary: listPath, cwd: tempWorkspace ?? "" };
		await expect(verifyOpenCodeSession("ses_08f7c2a9b1eF4d", options)).resolves.toBe(true);
		await expect(verifyOpenCodeSession("ses_9d8c7b6a5f4e", options)).resolves.toBe(true);
		await expect(verifyOpenCodeSession("ses_1a2b3c4d5e6f", options)).resolves.toBe(false);
	});

	it("compares whole fields so a prefix cannot match another session", async () => {
		const listPath = writeFixtureScript("opencode-sessions-prefix.sh", 'echo "ses_08f7c2a9b1eF4d  one session"');
		await expect(
			verifyOpenCodeSession("ses_08f7c2a9b1eF4", { binary: listPath, cwd: tempWorkspace ?? "" }),
		).resolves.toBe(false);
	});

	it("reports null when the probe itself could not run", async () => {
		const failingPath = writeFixtureScript("opencode-sessions-fail.sh", "exit 1");
		await expect(
			verifyOpenCodeSession("ses_08f7c2a9b1eF4d", { binary: failingPath, cwd: tempWorkspace ?? "" }),
		).resolves.toBeNull();
		// A value too short to be a real id is rejected before the CLI is asked.
		await expect(verifyOpenCodeSession("no", { binary: failingPath, cwd: tempWorkspace ?? "" })).resolves.toBe(false);
	});
});
