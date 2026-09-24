import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	pickBestInstalledAgentIdFromDetected,
	readGlobalRuntimeVerificationConfig,
	saveRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
	});
}

function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

describe.sequential("runtime-config auto agent selection", () => {
	it("selects agents using the configured priority order", () => {
		expect(pickBestInstalledAgentIdFromDetected(["codex", "opencode", "gemini"])).toBe("codex");
		expect(pickBestInstalledAgentIdFromDetected(["opencode", "droid", "gemini"])).toBe("droid");
		expect(pickBestInstalledAgentIdFromDetected(["kiro-cli", "gemini"])).toBe("kiro");
		expect(pickBestInstalledAgentIdFromDetected(["droid", "gemini", "cline"])).toBe("droid");
		expect(pickBestInstalledAgentIdFromDetected(["gemini", "cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["claude", "codex", "cline"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["claude", "droid"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected([])).toBeNull();
	});

	it("auto-selects and persists when unset", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-");

		try {
			writeFakeCommand(tempBin, "opencode");
			writeFakeCommand(tempBin, "codex");
			writeFakeCommand(tempBin, "gemini");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("codex");
					const persisted = JSON.parse(
						readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
					) as {
						selectedAgentId?: string;
						agentAutonomousModeEnabled?: boolean;
						readyForReviewNotificationsEnabled?: boolean;
						commitPromptTemplate?: string;
						openPrPromptTemplate?: string;
					};
					expect(persisted.selectedAgentId).toBe("codex");
					expect(persisted.agentAutonomousModeEnabled).toBeUndefined();
					expect(persisted.readyForReviewNotificationsEnabled).toBeUndefined();
					expect(persisted.commitPromptTemplate).toBeUndefined();
					expect(persisted.openPrPromptTemplate).toBeUndefined();

					const reloadedState = await loadRuntimeConfig(tempProject);
					expect(reloadedState.selectedAgentId).toBe("codex");
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not write config when no supported CLI is detected", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-default-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-default-");

		try {
			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("cline");
					expect(existsSync(join(tempHome, ".cline", "kanban", "config.json"))).toBe(false);
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("treats the home directory as global-only config scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-home-scope-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempHome);
				expect(state.globalConfigPath).toBe(join(tempHome, ".cline", "kanban", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);

				const updated = await updateRuntimeConfig(tempHome, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");
				expect(updated.projectConfigPath).toBeNull();

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					shortcuts?: unknown;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.shortcuts).toBeUndefined();
			});
		} finally {
			cleanupHome();
		}
	});

	it("loads global runtime config without a project scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-global-only-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadGlobalRuntimeConfig();
				expect(state.globalConfigPath).toBe(join(tempHome, ".cline", "kanban", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);
			});
		} finally {
			cleanupHome();
		}
	});

	it("normalizes unsupported configured agents to the default launch agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-set-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-set-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-set-");

		try {
			writeFakeCommand(tempBin, "claude");
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						selectedAgentId: "gemini",
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not auto-select when global config file already exists without selected agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-existing-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-existing-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-existing-");

		try {
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						readyForReviewNotificationsEnabled: true,
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("save omits default keys when they were not previously set", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-omit-defaults-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-omit-defaults-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shortcuts: [],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
					commitPromptTemplate?: string;
					openPrPromptTemplate?: string;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(globalPayload.commitPromptTemplate).toBeUndefined();
				expect(globalPayload.openPrPromptTemplate).toBeUndefined();
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes an existing empty project config file when no shortcuts are saved", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-cleanup-empty-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-cleanup-empty-",
		);

		try {
			const runtimeProjectConfigDir = join(tempProject, ".cline", "kanban");
			mkdirSync(runtimeProjectConfigDir, { recursive: true });
			writeFileSync(join(runtimeProjectConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shortcuts: [],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes the project config file when the last shortcut is deleted", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-remove-last-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-remove-last-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(true);

				await updateRuntimeConfig(tempProject, {
					shortcuts: [],
				});

				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-partial-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-partial-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const updated = await updateRuntimeConfig(tempProject, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					selectedShortcutLabel?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.selectedShortcutLabel).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists autonomous mode when disabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-autonomous-disabled-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-autonomous-disabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, {
					agentAutonomousModeEnabled: false,
				});
				expect(updated.agentAutonomousModeEnabled).toBe(false);

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					agentAutonomousModeEnabled?: boolean;
				};
				expect(globalPayload.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-concurrent-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-concurrent-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const [selectedAgentState, autonomousModeState] = await Promise.all([
					updateRuntimeConfig(tempProject, {
						selectedAgentId: "codex",
					}),
					updateRuntimeConfig(tempProject, {
						agentAutonomousModeEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("codex");
				expect(autonomousModeState.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});

describe("B-2.9 — context budget settings", () => {
	it("round-trips a full context budget through the global config file", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-budget-roundtrip-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-budget-roundtrip-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				const updated = await updateRuntimeConfig(tempProject, {
					contextBudget: {
						contextWindowOverrideTokens: 131_072,
						compactionStrategy: "agentic",
						triggerThresholdRatio: 0.75,
						outputReserveTokens: 8_192,
						safetyMarginTokens: 6_000,
					},
				});
				expect(updated.contextBudget).toEqual({
					contextWindowOverrideTokens: 131_072,
					compactionStrategy: "agentic",
					triggerThresholdRatio: 0.75,
					outputReserveTokens: 8_192,
					safetyMarginTokens: 6_000,
				});

				const filePayload = JSON.parse(readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8")) as {
					contextBudget?: Record<string, unknown>;
				};
				expect(filePayload.contextBudget).toEqual({
					contextWindowOverrideTokens: 131_072,
					compactionStrategy: "agentic",
					triggerThresholdRatio: 0.75,
					outputReserveTokens: 8_192,
					safetyMarginTokens: 6_000,
				});

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.contextBudget).toEqual({
					contextWindowOverrideTokens: 131_072,
					compactionStrategy: "agentic",
					triggerThresholdRatio: 0.75,
					outputReserveTokens: 8_192,
					safetyMarginTokens: 6_000,
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
	it("treats null fields as clear-to-default and undefined fields as untouched", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-budget-clear-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-budget-clear-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await updateRuntimeConfig(tempProject, {
					contextBudget: {
						contextWindowOverrideTokens: 131_072,
						compactionStrategy: "basic",
						triggerThresholdRatio: 0.9,
						outputReserveTokens: 4_096,
						safetyMarginTokens: 8_000,
					},
				});

				// Null clears a field; an absent (undefined) field leaves the
				// stored value in place.
				const cleared = await updateRuntimeConfig(tempProject, {
					contextBudget: {
						contextWindowOverrideTokens: null,
						triggerThresholdRatio: null,
						safetyMarginTokens: null,
					},
				});
				expect(cleared.contextBudget).toEqual({
					compactionStrategy: "basic",
					outputReserveTokens: 4_096,
				});

				// A whole-object null clears every setting.
				const clearedAll = await updateRuntimeConfig(tempProject, { contextBudget: null });
				expect(clearedAll.contextBudget).toBeUndefined();
				const filePayload = JSON.parse(readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8")) as {
					contextBudget?: unknown;
				};
				expect(filePayload.contextBudget).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("leaves a stored context budget untouched when the update omits it", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-budget-preserve-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-budget-preserve-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await updateRuntimeConfig(tempProject, {
					contextBudget: { outputReserveTokens: 2_048 },
				});
				const updated = await updateRuntimeConfig(tempProject, {
					readyForReviewNotificationsEnabled: false,
				});
				expect(updated.contextBudget).toEqual({ outputReserveTokens: 2_048 });
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("rejects invalid context budget values on save", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-budget-invalid-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-budget-invalid-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { contextWindowOverrideTokens: -5 },
					}),
				).rejects.toThrow("contextWindowOverrideTokens must be a positive integer token count.");
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { triggerThresholdRatio: 1.5 },
					}),
				).rejects.toThrow("triggerThresholdRatio must be a number between 0 and 1 (exclusive of 0).");
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { compactionStrategy: "aggressive" as never },
					}),
				).rejects.toThrow("compactionStrategy must be either 'basic' or 'agentic'.");
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { triggerThresholdRatio: 0 },
					}),
				).rejects.toThrow("triggerThresholdRatio must be a number between 0 and 1 (exclusive of 0).");
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { triggerThresholdRatio: 1.2 },
					}),
				).rejects.toThrow("triggerThresholdRatio must be a number between 0 and 1 (exclusive of 0).");
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { outputReserveTokens: 1.5 },
					}),
				).rejects.toThrow("outputReserveTokens must be a positive integer token count.");
				await expect(
					updateRuntimeConfig(tempProject, {
						contextBudget: { safetyMarginTokens: -1 },
					}),
				).rejects.toThrow("safetyMarginTokens must be a positive integer token count.");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("drops corrupted context budget fields when loading instead of failing", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-budget-corrupt-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-budget-corrupt-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				mkdirSync(join(tempHome, ".cline", "kanban"), { recursive: true });
				writeFileSync(
					join(tempHome, ".cline", "kanban", "config.json"),
					JSON.stringify({
						contextBudget: {
							contextWindowOverrideTokens: "big",
							compactionStrategy: "aggressive",
							triggerThresholdRatio: 1.5,
							outputReserveTokens: 4_096,
							safetyMarginTokens: 0,
						},
					}),
					"utf8",
				);
				const state = await loadRuntimeConfig(tempProject);
				// Only the valid field survives normalization.
				expect(state.contextBudget).toEqual({ outputReserveTokens: 4_096 });
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});

describe("B-7.1 — verification gate settings", () => {
	it("saves a verification config and reloads it with normalized defaults", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-verification-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-verification-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				const state = await updateRuntimeConfig(tempProject, {
					verification: {
						enabled: "required",
						checks: [
							{
								id: "lint",
								command: "npm",
								args: ["run", "lint"],
								timeoutMs: 60_000,
								env: { CI: "1" },
								successExitCodes: [0, 1],
							},
							{ id: "fmt", command: "prettier", args: ["--check", "."], required: false },
						],
					},
				});
				expect(state.verification).toEqual({
					enabled: "required",
					checks: [
						{
							id: "lint",
							command: "npm",
							args: ["run", "lint"],
							timeoutMs: 60_000,
							env: { CI: "1" },
							successExitCodes: [0, 1],
							required: true,
						},
						{
							id: "fmt",
							command: "prettier",
							args: ["--check", "."],
							successExitCodes: [0],
							required: false,
						},
					],
				});

				const filePayload = JSON.parse(readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8")) as {
					verification?: { enabled?: string; checks?: unknown[] };
				};
				expect(filePayload.verification?.enabled).toBe("required");
				expect(filePayload.verification?.checks).toHaveLength(2);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.verification).toEqual(state.verification);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("merges a partial verification update with the stored config", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-verification-merge-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-verification-merge-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await updateRuntimeConfig(tempProject, {
					verification: {
						enabled: "required",
						checks: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
					},
				});
				const updated = await updateRuntimeConfig(tempProject, {
					verification: { enabled: "off" },
				});
				expect(updated.verification).toEqual({
					enabled: "off",
					checks: [
						{
							id: "lint",
							command: "npm",
							args: ["run", "lint"],
							successExitCodes: [0],
							required: true,
						},
					],
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("clears the verification config with an explicit null", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-verification-clear-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-verification-clear-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await updateRuntimeConfig(tempProject, {
					verification: {
						enabled: "required",
						checks: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
					},
				});
				const cleared = await updateRuntimeConfig(tempProject, { verification: null });
				expect(cleared.verification).toBeUndefined();
				const filePayload = JSON.parse(readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8")) as {
					verification?: unknown;
				};
				expect(filePayload.verification).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("leaves a stored verification config untouched when the update omits it", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"kanban-home-runtime-config-verification-preserve-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-verification-preserve-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await updateRuntimeConfig(tempProject, {
					verification: {
						enabled: "required",
						checks: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
					},
				});
				const updated = await updateRuntimeConfig(tempProject, {
					readyForReviewNotificationsEnabled: false,
				});
				expect(updated.verification).toEqual({
					enabled: "required",
					checks: [
						{
							id: "lint",
							command: "npm",
							args: ["run", "lint"],
							successExitCodes: [0],
							required: true,
						},
					],
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("rejects unsafe check cwds and duplicate check ids on save", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"kanban-home-runtime-config-verification-invalid-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-verification-invalid-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await expect(
					updateRuntimeConfig(tempProject, {
						verification: {
							enabled: "required",
							checks: [
								{ id: "a", command: "x" },
								{ id: "a", command: "y" },
							],
						},
					}),
				).rejects.toThrow('verification config has duplicate check id "a".');
				await expect(
					updateRuntimeConfig(tempProject, {
						verification: {
							enabled: "required",
							checks: [{ id: "a", command: "x", cwd: "../outside" }],
						},
					}),
				).rejects.toThrow('verification check "a" cwd must be a relative path inside the worktree.');
				await expect(
					updateRuntimeConfig(tempProject, {
						verification: {
							enabled: "required",
							checks: [{ id: "a", command: "x", successExitCodes: [] }],
						},
					}),
				).rejects.toThrow('verification check "a" successExitCodes must be a non-empty array of 0-255 integers.');
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("drops corrupted check entries when loading instead of failing", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"kanban-home-runtime-config-verification-corrupt-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-verification-corrupt-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				mkdirSync(join(tempHome, ".cline", "kanban"), { recursive: true });
				writeFileSync(
					join(tempHome, ".cline", "kanban", "config.json"),
					JSON.stringify({
						verification: {
							enabled: "required",
							checks: [
								{ id: "  ", command: "x" },
								{ id: "good", command: "make", successExitCodes: [0, 999] },
								{ id: "traverse", command: "y", cwd: "../x" },
							],
						},
					}),
					"utf8",
				);
				const state = await loadRuntimeConfig(tempProject);
				// The empty-id check is dropped, the traversal cwd is stripped,
				// and the out-of-range exit code is filtered out.
				expect(state.verification).toEqual({
					enabled: "required",
					checks: [
						{ id: "good", command: "make", args: [], successExitCodes: [0], required: true },
						{ id: "traverse", command: "y", args: [], successExitCodes: [0], required: true },
					],
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("readGlobalRuntimeVerificationConfig reads only the gate without side effects", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-verification-read-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				expect(await readGlobalRuntimeVerificationConfig()).toBeUndefined();

				mkdirSync(join(tempHome, ".cline", "kanban"), { recursive: true });
				writeFileSync(
					join(tempHome, ".cline", "kanban", "config.json"),
					JSON.stringify({
						verification: { enabled: "required", checks: [{ id: "build", command: "make" }] },
					}),
					"utf8",
				);
				expect(await readGlobalRuntimeVerificationConfig()).toEqual({
					enabled: "required",
					checks: [{ id: "build", command: "make", args: [], successExitCodes: [0], required: true }],
				});
			});
		} finally {
			cleanupHome();
		}
	});
});
