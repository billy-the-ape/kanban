import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import { getWorkspacesRootPath, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

it.each(["missing directory", "invalid Git configuration"])(
	"retains on-disk board and sessions after %s and reopens them after repair",
	async (failure) => {
		const fixture = createTempDir("kanban-validation-");
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.HOME = join(fixture.path, "home");
		process.env.USERPROFILE = process.env.HOME;
		const repoPath = join(fixture.path, "project");
		const displacedPath = join(fixture.path, "displaced-project");
		mkdirSync(repoPath);
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: repoPath, env: createGitTestEnv(), encoding: "utf8" }).trim();
		try {
			git(["init", "-q"]);
			const initial = await loadWorkspaceState(repoPath);
			const board = {
				...initial.board,
				columns: initial.board.columns.map((column) =>
					column.id === "backlog"
						? {
								...column,
								cards: [
									{
										id: "retained-task",
										title: "Retained task",
										prompt: "Retained prompt",
										startInPlanMode: false,
										autoReviewEnabled: false,
										baseRef: "HEAD",
										createdAt: 1,
										updatedAt: 1,
									},
								],
							}
						: column,
				),
			};
			await saveWorkspaceState(repoPath, { board, sessions: initial.sessions, expectedRevision: initial.revision });
			const registry = await createWorkspaceRegistry({
				cwd: repoPath,
				loadGlobalRuntimeConfig,
				loadRuntimeConfig,
				hasGitRepository: (path) =>
					execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
						cwd: path,
						env: createGitTestEnv(),
						encoding: "utf8",
					}).trim() === "true",
				pathIsDirectory: async (path) => existsSync(path),
			});
			const workspaceId = registry.getActiveWorkspaceId();
			if (!workspaceId) {
				throw new Error("Missing registered project");
			}
			const root = getWorkspacesRootPath();
			const files = [
				"index.json",
				...["board.json", "sessions.json", "meta.json"].map((name) => join(workspaceId, name)),
			];
			const before = files.map((file) => readFileSync(join(root, file), "utf8"));
			if (failure === "missing directory") {
				renameSync(repoPath, displacedPath);
			} else {
				git(["config", "--local", "core.bare", "true"]);
			}
			const result = await registry.resolveWorkspaceForStream(workspaceId);
			expect(result.workspaceId).toBeNull();
			expect(result.unavailableRequestedWorkspaceMessage).toContain("Project and task data retained");
			expect(files.map((file) => readFileSync(join(root, file), "utf8"))).toEqual(before);
			expect((await registry.buildProjectsPayload(workspaceId)).projects.map((project) => project.id)).toContain(
				workspaceId,
			);
			if (failure === "missing directory") {
				renameSync(displacedPath, repoPath);
			} else {
				git(["config", "--local", "core.bare", "false"]);
			}
			expect((await registry.resolveWorkspaceForStream(workspaceId)).workspaceId).toBe(workspaceId);
			const restored = await registry.buildWorkspaceStateSnapshot(workspaceId, repoPath);
			expect(restored.board.columns.find((column) => column.id === "backlog")?.cards[0]?.prompt).toBe(
				"Retained prompt",
			);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousProfile;
			}
			fixture.cleanup();
		}
	},
);
