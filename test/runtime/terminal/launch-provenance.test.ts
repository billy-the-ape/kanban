import { describe, expect, it } from "vitest";
import { KANBAN_HOOK_ATTEMPT_ID_ENV } from "../../../src/terminal/hook-runtime-context";
import {
	buildLaunchConfigFingerprint,
	collectLaunchConfigFingerprintParts,
	createLaunchProvenance,
	didLaunchConfigurationChange,
	extractRequestedModelFromLaunchArgs,
	isSecretLikeEnvKey,
} from "../../../src/terminal/launch-provenance";

const ATTEMPT_SCOPED_SETTINGS_PATH = `${process.env.HOME ?? "/home/user"}/.cline/kanban/hooks/claude/workspace-1-1111111111/task-1-2222222222/attempt-1-3333333333/settings.json`;
const NEXT_ATTEMPT_SCOPED_SETTINGS_PATH = `${process.env.HOME ?? "/home/user"}/.cline/kanban/hooks/claude/workspace-1-4444444444/task-1-5555555555/attempt-2-6666666666/settings.json`;

function createProvenance(overrides: Partial<Parameters<typeof createLaunchProvenance>[0]> = {}) {
	return createLaunchProvenance({
		attemptId: "attempt-1",
		agentId: "claude",
		binary: "claude",
		args: ["--settings", ATTEMPT_SCOPED_SETTINGS_PATH],
		env: { CLAUDE_CODE_ENTRYPOINT: "kanban" },
		prompt: "Fix the flaky test",
		cwd: "/tmp/worktree",
		taskId: "task-1",
		workspaceId: "workspace-1",
		startedAt: 1700000000000,
		...overrides,
	});
}

describe("launch provenance (AA-S1)", () => {
	it("fingerprints the settings a launch was started with", () => {
		const fingerprint = buildLaunchConfigFingerprint({
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "auto"],
			env: { CLAUDE_CODE_ENTRYPOINT: "kanban" },
		});
		expect(fingerprint.startsWith("sha256:")).toBe(true);
		expect(fingerprint).toBe(
			buildLaunchConfigFingerprint({
				agentId: "claude",
				binary: "claude",
				args: ["--permission-mode", "auto"],
				env: { CLAUDE_CODE_ENTRYPOINT: "kanban" },
			}),
		);
		// A real configuration change has to be visible.
		expect(
			buildLaunchConfigFingerprint({
				agentId: "claude",
				binary: "claude",
				args: ["--permission-mode", "default"],
				env: { CLAUDE_CODE_ENTRYPOINT: "kanban" },
			}),
		).not.toBe(fingerprint);
	});

	it("does not treat the per-attempt token or generated paths as a configuration change", () => {
		const first = createProvenance();
		const second = createProvenance({
			attemptId: "attempt-2",
			args: ["--settings", NEXT_ATTEMPT_SCOPED_SETTINGS_PATH],
			env: {
				CLAUDE_CODE_ENTRYPOINT: "kanban",
				[KANBAN_HOOK_ATTEMPT_ID_ENV]: "attempt-2",
			},
			startedAt: 1700000009999,
		});

		// Restarting the same card mints a new token and a new generated
		// settings file; neither means the operator changed any setting.
		expect(second.configFingerprint).toBe(first.configFingerprint);
		expect(second.attemptId).toBe("attempt-2");
	});

	it("keeps credentials and prompt text out of the fingerprint", () => {
		const parts = collectLaunchConfigFingerprintParts({
			agentId: "codex",
			binary: "codex",
			args: ["-c", "model_provider=local", "summarize the failing migration"],
			env: {
				OPENAI_API_KEY: "sk-do-not-store-me",
				OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
				PATH: "/usr/bin:/bin",
			},
			prompt: "summarize the failing migration",
		});
		const joined = parts.join("\n");

		// A credential contributes nothing to the fingerprint: not its value,
		// not even its name.
		expect(isSecretLikeEnvKey("OPENAI_API_KEY")).toBe(true);
		expect(joined).not.toContain("OPENAI_API_KEY");
		expect(joined).not.toContain("sk-do-not-store-me");
		// Configuration-shaped values are kept, unrelated process env is not.
		expect(joined).toContain("env=OPENAI_BASE_URL=http://127.0.0.1:8080/v1");
		expect(joined).not.toContain("/usr/bin:/bin");
		// The prompt is conversation content, not configuration.
		expect(joined).not.toContain("summarize the failing migration");
	});

	it("reads the requested model back from launch arguments without guessing the observed one", () => {
		expect(extractRequestedModelFromLaunchArgs(["--model", "local/qwen3.5-coder"])).toBe("local/qwen3.5-coder");
		expect(extractRequestedModelFromLaunchArgs(["--model=local/qwen3.5-coder"])).toBe("local/qwen3.5-coder");
		expect(extractRequestedModelFromLaunchArgs(["--model", "--auto"])).toBeNull();
		expect(extractRequestedModelFromLaunchArgs([])).toBeNull();

		const provenance = createProvenance({ agentId: "opencode", args: ["--model", "local/qwen3.5-coder"] });
		expect(provenance.requestedModel).toBe("local/qwen3.5-coder");
		// Nothing in this record may claim what model the agent really used.
		expect(provenance.observedModel).toBeNull();
		expect(provenance.agentVersion).toBeNull();
	});

	it("records where the model is configured and which identity the attempt belongs to", () => {
		const provenance = createProvenance();
		expect(provenance.modelSource).toBe("agent-native");
		expect(provenance.configLocations.length).toBeGreaterThan(0);
		expect(provenance.agentLabel).toBe("Claude Code");
		expect(provenance).toMatchObject({
			agentId: "claude",
			binary: "claude",
			cwd: "/tmp/worktree",
			taskId: "task-1",
			workspaceId: "workspace-1",
			startedAt: 1700000000000,
		});
		// The first launch of a card has nothing to compare against.
		expect(provenance.previousConfigFingerprint).toBeNull();
	});

	it("reports a deliberate resume after a configuration change", () => {
		const first = createProvenance();
		const unchanged = createProvenance();
		const changed = createProvenance({ args: ["--permission-mode", "auto"] });

		expect(didLaunchConfigurationChange(undefined, changed)).toBe(false);
		expect(didLaunchConfigurationChange(first, unchanged)).toBe(false);
		expect(didLaunchConfigurationChange(first, changed)).toBe(true);
	});
});
