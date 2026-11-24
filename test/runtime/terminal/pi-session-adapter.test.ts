// AA-P1: the Pi launch contract. Every assertion here is about a fact Kanban
// owns: the exact session it names, the extension it generates, and the model
// request it forwards from Pi's own settings instead of inventing.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PR_CI_HANDOFF_GUIDANCE } from "../../../src/prompts/pr-ci-handoff";
import { type AgentAdapterLaunchInput, prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { preparePiLaunch, withPiCiHandoffGuidance } from "../../../src/terminal/pi-session-adapter";
import {
	buildPiLaunchArgs,
	derivePiSessionId,
	getPiAgentDir,
	getPiTaskSessionDir,
	isValidPiSessionId,
	readPiModelDefaults,
	readPiSessionRecord,
	resolvePiModelFlags,
} from "../../../src/terminal/pi-session-options";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDirOverride = process.env.PI_CODING_AGENT_DIR;
let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-pi-adapter-"));
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	delete process.env.PI_CODING_AGENT_DIR;
	return tempHome;
}

function restoreHome(): void {
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (originalAgentDirOverride === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDirOverride;
	}
}

function piLaunchInput(overrides: Partial<AgentAdapterLaunchInput> = {}): AgentAdapterLaunchInput {
	return {
		taskId: "task-1",
		agentId: "pi",
		binary: "pi",
		args: [],
		cwd: "/tmp/kanban-pi-worktree",
		prompt: "Fix the flaky test",
		workspaceId: "workspace-1",
		...overrides,
	};
}

function flagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === flag) {
			values.push(args[index + 1] ?? "");
		}
	}
	return values;
}

async function writePiSettings(home: string, settings: Record<string, unknown>): Promise<void> {
	const agentDir = join(home, ".pi", "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

afterEach(() => {
	restoreHome();
});

describe("buildPiLaunchArgs", () => {
	it("names the Kanban-owned session instead of asking for the latest one", () => {
		const args = buildPiLaunchArgs({
			args: [],
			sessionDir: "/home/user/.cline/kanban/pi/skills/ws/task",
			sessionId: "kanban-abc123",
			extensionPath: "/home/user/.cline/kanban/hooks/pi/ws/task/attempt/kanban-pi-hook.js",
		});

		expect(flagValues(args, "--session-dir")).toEqual(["/home/user/.cline/kanban/pi/skills/ws/task"]);
		expect(flagValues(args, "--session-id")).toEqual(["kanban-abc123"]);
		expect(flagValues(args, "--extension")).toHaveLength(1);
		// An unattended run must not be able to trust project-local resources.
		expect(args).toContain("--no-approve");
		expect(args).not.toContain("--continue");
		expect(args).not.toContain("--resume");
	});

	it("leaves a user-supplied session selection, trust and model choice alone", () => {
		const args = buildPiLaunchArgs({
			args: ["--continue", "--approve", "--model", "custom-model", "--session-dir", "/custom/sessions"],
			sessionDir: "/kanban/sessions",
			sessionId: "kanban-abc123",
			extensionPath: "/kanban/hook.js",
			modelArgs: ["--provider", "kanban", "--model", "kanban-model"],
		});

		expect(args).not.toContain("--session-id");
		expect(flagValues(args, "--session-dir")).toEqual(["/custom/sessions"]);
		expect(args).not.toContain("--no-approve");
		expect(flagValues(args, "--model")).toEqual(["custom-model"]);
		expect(args).not.toContain("--provider");
	});

	it("loads the generated extension exactly once", () => {
		const args = buildPiLaunchArgs({
			args: ["--extension", "/kanban/hook.js"],
			sessionDir: "/kanban/sessions",
			sessionId: "kanban-abc123",
			extensionPath: "/kanban/hook.js",
		});
		expect(flagValues(args, "--extension")).toEqual(["/kanban/hook.js"]);
	});

	it("passes no model flags when Pi has no explicit default", () => {
		expect(resolvePiModelFlags({ defaultProvider: null, defaultModel: null }).args).toEqual([]);
		expect(resolvePiModelFlags({ defaultProvider: "local", defaultModel: null }).args).toEqual([]);
		expect(resolvePiModelFlags({ defaultProvider: null, defaultModel: "qwen3-coder" })).toEqual({
			args: ["--model", "qwen3-coder"],
			requestedModel: "qwen3-coder",
		});
		expect(resolvePiModelFlags({ defaultProvider: "local", defaultModel: "qwen3-coder" }).args).toEqual([
			"--provider",
			"local",
			"--model",
			"qwen3-coder",
		]);
	});
});

describe("derivePiSessionId", () => {
	it("is stable per task so a restart resumes the same file", () => {
		const scope = { workspaceId: "workspace-1", taskId: "task-1" };
		expect(derivePiSessionId(scope)).toBe(derivePiSessionId(scope));
		expect(derivePiSessionId({ ...scope, taskId: "task-2" })).not.toBe(derivePiSessionId(scope));
		expect(isValidPiSessionId(derivePiSessionId(scope))).toBe(true);
	});

	it("lives in a Kanban-owned per-task directory", () => {
		const home = setupTempHome();
		const sessionDir = getPiTaskSessionDir({ workspaceId: "workspace-1", taskId: "task-1" });
		expect(sessionDir).toContain(join(".cline", "kanban", "pi", "sessions"));
		expect(sessionDir).toContain("workspace-1");
		expect(sessionDir).toContain("task-1");
		// Pi's own per-user catalogue stays free of Kanban bookkeeping.
		expect(sessionDir.startsWith(join(home, ".pi"))).toBe(false);
	});
});

describe("readPiModelDefaults", () => {
	it("reads only the explicit default selection from Pi settings", async () => {
		const home = setupTempHome();
		await writePiSettings(home, { defaultProvider: "local", defaultModel: "qwen3-coder", quietStartup: true });
		await expect(readPiModelDefaults()).resolves.toEqual({
			defaultProvider: "local",
			defaultModel: "qwen3-coder",
		});
	});

	it("treats a missing settings file as no explicit selection", async () => {
		setupTempHome();
		await expect(readPiModelDefaults()).resolves.toEqual({ defaultProvider: null, defaultModel: null });
	});

	it("honours the same directory override Pi itself reads", async () => {
		const home = setupTempHome();
		const relocated = join(home, "relocated-pi");
		await writePiSettings(relocated, { defaultModel: "relocated-model" });
		// `writePiSettings` nests below the given directory, so point at the parent.
		const agentDir = getPiAgentDir({ PI_CODING_AGENT_DIR: join(relocated, ".pi", "agent") });
		expect(agentDir).toBe(join(relocated, ".pi", "agent"));
		await expect(readPiModelDefaults(agentDir)).resolves.toEqual({
			defaultProvider: null,
			defaultModel: "relocated-model",
		});
	});
});

describe("readPiSessionRecord", () => {
	it("finds only the session Kanban owns", async () => {
		setupTempHome();
		const sessionDir = getPiTaskSessionDir({ workspaceId: "workspace-1", taskId: "task-1" });
		const sessionId = derivePiSessionId({ workspaceId: "workspace-1", taskId: "task-1" });
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, "other.jsonl"),
			`${JSON.stringify({ type: "session", id: "someone-elses-session", cwd: "/tmp/other" })}\n`,
			"utf8",
		);

		await expect(readPiSessionRecord({ sessionId, sessionDir })).resolves.toEqual({
			found: false,
			sessionFile: null,
			sessionCwd: null,
		});

		const ownedFile = join(sessionDir, "owned.jsonl");
		await writeFile(
			ownedFile,
			`${JSON.stringify({ type: "session", id: sessionId, cwd: "/tmp/kanban-pi-worktree" })}\n`,
			"utf8",
		);
		await expect(readPiSessionRecord({ sessionId, sessionDir })).resolves.toEqual({
			found: true,
			sessionFile: ownedFile,
			sessionCwd: "/tmp/kanban-pi-worktree",
		});
	});
});

describe("Pi CI handoff policy", () => {
	it("adds CI no-poll instructions once to real task prompts", () => {
		const prompt = withPiCiHandoffGuidance("Open the PR");
		expect(prompt).toContain("do not sleep, poll, watch checks");
		expect(withPiCiHandoffGuidance(prompt)).toBe(prompt);
	});
	it("does not transform empty restore prompts into model turns", () => {
		expect(withPiCiHandoffGuidance("")).toBe("");
		expect(withPiCiHandoffGuidance("   ")).toBe("   ");
	});
});

describe("preparePiLaunch", () => {
	it("starts the task in its own session with the generated extension", async () => {
		setupTempHome();
		const launch = await preparePiLaunch(piLaunchInput());
		const sessionId = derivePiSessionId({ workspaceId: "workspace-1", taskId: "task-1" });

		expect(launch.session.sessionId).toBe(sessionId);
		expect(flagValues(launch.args, "--session-id")).toEqual([sessionId]);
		expect(flagValues(launch.args, "--session-dir")).toEqual([launch.session.sessionDir]);
		expect(launch.session.resumed).toBe(false);

		const extensionPath = flagValues(launch.args, "--extension")[0];
		expect(extensionPath).toBeDefined();
		const extensionSource = await readFile(extensionPath ?? "", "utf8");
		expect(extensionSource).toContain(sessionId);
		expect(extensionSource).toContain("kanban hooks notify");
		// Credentials never travel through a generated file.
		expect(extensionSource).not.toMatch(/api[_-]?key/i);

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		// The prompt is appended as data after `--`, never as an option Pi parses.
		const promptIndex = launch.args.length - 1;
		expect(launch.args[promptIndex]).toContain("Fix the flaky test");
		expect(launch.args[promptIndex]).toContain(PR_CI_HANDOFF_GUIDANCE);
		expect(launch.args[promptIndex - 1]).toBe("--");
	});

	it("keeps a prompt that starts with a dash away from option parsing", async () => {
		setupTempHome();
		const launch = await preparePiLaunch(piLaunchInput({ prompt: "--no-session is not what I meant" }));
		expect(launch.args.at(-2)).toBe("--");
		expect(launch.args.at(-1)).toContain("--no-session is not what I meant");
	});

	it("reports the next launch as a resume of the session it created", async () => {
		setupTempHome();
		const first = await preparePiLaunch(piLaunchInput());
		const sessionDir = first.session.sessionDir;
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, "session.jsonl"),
			`${JSON.stringify({ type: "session", id: first.session.sessionId, cwd: "/tmp/kanban-pi-worktree" })}\n`,
			"utf8",
		);

		const second = await preparePiLaunch(piLaunchInput());
		expect(second.session.resumed).toBe(true);
		expect(second.session.sessionFile).toBe(join(sessionDir, "session.jsonl"));
		expect(second.session.sessionId).toBe(first.session.sessionId);
	});

	it("forwards the model from Pi settings without inventing a provider", async () => {
		const home = setupTempHome();
		await writePiSettings(home, { defaultProvider: "vllm", defaultModel: "Qwen3-Coder" });
		const launch = await preparePiLaunch(piLaunchInput());

		expect(flagValues(launch.args, "--provider")).toEqual(["vllm"]);
		expect(flagValues(launch.args, "--model")).toEqual(["Qwen3-Coder"]);
		expect(launch.modelArgs).toEqual(["--provider", "vllm", "--model", "Qwen3-Coder"]);
	});

	it("refuses plan mode by name instead of starting an Act run", async () => {
		setupTempHome();
		await expect(preparePiLaunch(piLaunchInput({ startInPlanMode: true }))).rejects.toThrow(
			/Pi does not support plan mode/,
		);
	});

	it("keeps session evidence out of the shared launch contract", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch(piLaunchInput());
		expect(Object.hasOwn(launch, "session")).toBe(false);
		expect(launch.args).toContain("--session-id");
	});
});
