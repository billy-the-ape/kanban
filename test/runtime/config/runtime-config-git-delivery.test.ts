// B-8: git delivery policy — normalization, persistence, and merge behavior.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import {
	loadRuntimeConfig,
	normalizeGitDeliveryPolicy,
	saveRuntimeConfig,
	toGlobalRuntimeConfigState,
	updateGlobalRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryHome<T>(home: string, run: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
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
	});
}

function readGlobalPayload(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(home, ".cline", "kanban", "config.json"), "utf8")) as Record<string, unknown>;
}

function toFullSaveConfig(current: RuntimeConfigState) {
	return {
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		shortcuts: current.shortcuts,
		commitPromptTemplate: current.commitPromptTemplateDefault,
		openPrPromptTemplate: current.openPrPromptTemplateDefault,
	};
}

describe("normalizeGitDeliveryPolicy", () => {
	it("returns undefined for absent values", () => {
		expect(normalizeGitDeliveryPolicy(undefined)).toBeUndefined();
		expect(normalizeGitDeliveryPolicy(null)).toBeUndefined();
		expect(normalizeGitDeliveryPolicy("enabled")).toBeUndefined();
		expect(normalizeGitDeliveryPolicy([])).toBeUndefined();
	});

	it("fills defaults for a partial policy", () => {
		expect(normalizeGitDeliveryPolicy({ enabled: true })).toEqual({
			enabled: true,
			remote: "origin",
			destinationBranch: null,
			pushRequired: true,
			protectedBranches: ["main", "master"],
			integrationStrategy: "fast_forward",
			requirePullRequest: false,
			pullRequestBaseBranch: null,
		});
	});

	it("keeps a valid pullRequestBaseBranch and drops an invalid one", () => {
		expect(normalizeGitDeliveryPolicy({ pullRequestBaseBranch: "develop" })?.pullRequestBaseBranch).toBe("develop");
		expect(normalizeGitDeliveryPolicy({ pullRequestBaseBranch: "bad name" })?.pullRequestBaseBranch).toBeNull();
	});

	it("keeps valid values and degrades invalid ref names to defaults", () => {
		const normalized = normalizeGitDeliveryPolicy({
			remote: "bad name",
			destinationBranch: "feature/b8",
			protectedBranches: ["main", "../evil"],
			integrationStrategy: "merge",
		});
		expect(normalized?.enabled).toBe(false);
		expect(normalized?.remote).toBe("origin");
		expect(normalized?.destinationBranch).toBe("feature/b8");
		expect(normalized?.protectedBranches).toEqual(["main"]);
		expect(normalized?.integrationStrategy).toBe("merge");
	});

	it("treats an explicit null destinationBranch as 'use the task base ref'", () => {
		expect(normalizeGitDeliveryPolicy({ destinationBranch: null })?.destinationBranch).toBeNull();
		expect(normalizeGitDeliveryPolicy({ destinationBranch: "bad name" })?.destinationBranch).toBeNull();
	});
});

describe("git delivery policy persistence", () => {
	it("saves, normalizes, and reloads the policy", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-git-delivery-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-git-delivery-");
		try {
			await withTemporaryHome(tempHome, async () => {
				const current = await loadRuntimeConfig(tempProject);
				expect(current.gitDeliveryPolicy).toBeUndefined();

				const saved = await saveRuntimeConfig(tempProject, {
					...toFullSaveConfig(current),
					gitDeliveryPolicy: { enabled: true, destinationBranch: "feature/b8" },
				});
				expect(saved.gitDeliveryPolicy).toEqual({
					enabled: true,
					remote: "origin",
					destinationBranch: "feature/b8",
					pushRequired: true,
					protectedBranches: ["main", "master"],
					integrationStrategy: "fast_forward",
					requirePullRequest: false,
					pullRequestBaseBranch: null,
				});

				const payload = readGlobalPayload(tempHome);
				expect(payload.gitDeliveryPolicy).toMatchObject({ enabled: true, destinationBranch: "feature/b8" });

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.gitDeliveryPolicy?.enabled).toBe(true);
				expect(reloaded.gitDeliveryPolicy?.destinationBranch).toBe("feature/b8");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("merges partial updates and clears the policy with null", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-git-delivery-merge-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-git-delivery-merge-");
		try {
			await withTemporaryHome(tempHome, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					...toFullSaveConfig(current),
					gitDeliveryPolicy: { enabled: true, destinationBranch: "feature/b8" },
				});

				const merged = await updateRuntimeConfig(tempProject, {
					gitDeliveryPolicy: { remote: "fork" },
				});
				expect(merged.gitDeliveryPolicy?.enabled).toBe(true);
				expect(merged.gitDeliveryPolicy?.remote).toBe("fork");
				expect(merged.gitDeliveryPolicy?.destinationBranch).toBe("feature/b8");

				const cleared = await updateRuntimeConfig(tempProject, { gitDeliveryPolicy: null });
				expect(cleared.gitDeliveryPolicy).toBeUndefined();
				expect(readGlobalPayload(tempHome).gitDeliveryPolicy).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("rejects invalid ref names on save", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-git-delivery-invalid-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-git-delivery-invalid-");
		try {
			await withTemporaryHome(tempHome, async () => {
				await expect(
					updateRuntimeConfig(tempProject, { gitDeliveryPolicy: { remote: "bad remote" } }),
				).rejects.toThrow("gitDeliveryPolicy.remote is not a valid git ref name.");
				await expect(
					updateRuntimeConfig(tempProject, { gitDeliveryPolicy: { destinationBranch: "../evil" } }),
				).rejects.toThrow("gitDeliveryPolicy.destinationBranch is not a valid git ref name.");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("keeps the policy across global config state updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-git-delivery-global-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-git-delivery-global-");
		try {
			await withTemporaryHome(tempHome, async () => {
				const current = await loadRuntimeConfig(tempProject);
				const saved = await saveRuntimeConfig(tempProject, {
					...toFullSaveConfig(current),
					gitDeliveryPolicy: { enabled: true, destinationBranch: "feature/b8" },
				});

				const globalState = toGlobalRuntimeConfigState(saved);
				expect(globalState.gitDeliveryPolicy?.enabled).toBe(true);

				const updated = await updateGlobalRuntimeConfig(globalState, {
					gitDeliveryPolicy: { pushRequired: false },
				});
				expect(updated.gitDeliveryPolicy?.enabled).toBe(true);
				expect(updated.gitDeliveryPolicy?.pushRequired).toBe(false);
				expect(updated.gitDeliveryPolicy?.destinationBranch).toBe("feature/b8");
				expect(readGlobalPayload(tempHome).gitDeliveryPolicy).toMatchObject({
					enabled: true,
					pushRequired: false,
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
