import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import treeKill from "tree-kill";

import { terminateProcessForTimeout } from "../../server/process-termination";

import { getGitCommandErrorMessage } from "../git-utils";
import type { DependencyInstallPlan, WorktreePackageManagerId } from "./types";

/**
 * Install commands per package manager. Two product rules shape these flags:
 *
 * 1. Never write into the task's would-be commit. A project without a lockfile
 *    gets `--no-package-lock`/`--lockfile=false` so Kanban cannot leave an
 *    untracked `package-lock.json` for the agent to commit.
 * 2. Prefer the package manager's own global cache (`--prefer-offline`, pnpm's
 *    content-addressable store, Bun's install cache) so a cold cache entry is
 *    still an offline-mostly install. That store is the "central cache" this
 *    subsystem layers on top of.
 */
export function buildInstallPlan(options: {
	packageManager: WorktreePackageManagerId;
	hasLockfile: boolean;
}): DependencyInstallPlan {
	const env = baseInstallEnv();
	switch (options.packageManager) {
		case "pnpm":
			return {
				command: "pnpm",
				args: options.hasLockfile
					? ["install", "--frozen-lockfile", "--prefer-offline"]
					: ["install", "--lockfile=false", "--prefer-offline"],
				env,
			};
		case "yarn":
			return {
				command: "yarn",
				args: options.hasLockfile
					? ["install", "--frozen-lockfile", "--prefer-offline", "--no-audit", "--no-progress"]
					: ["install", "--no-lockfile", "--prefer-offline", "--no-audit", "--no-progress"],
				env,
			};
		case "yarn-berry":
			// Berry has no lockfile-disabling flag, so it is only used where the
			// project already tracks a lockfile (the normal berry setup).
			return {
				command: "yarn",
				args: options.hasLockfile ? ["install", "--immutable"] : ["install"],
				env,
			};
		case "bun":
			return {
				command: "bun",
				args: options.hasLockfile ? ["install", "--frozen-lockfile"] : ["install", "--no-summary"],
				env,
			};
		default:
			// npm, and any manager this detection could not classify: npm remains
			// the safest default because package.json without a lockfile resolves
			// the same way for every manager.
			return {
				command: "npm",
				args: options.hasLockfile
					? ["ci", "--no-audit", "--no-fund", "--prefer-offline"]
					: ["install", "--no-audit", "--no-fund", "--prefer-offline", "--no-package-lock"],
				env,
			};
	}
}

function baseInstallEnv(): Record<string, string> {
	return {
		// Kanban-owned installs must not rewrite tracked manifests (corepack
		// auto-pin) or install git hooks into the task worktree (husky).
		COREPACK_ENABLE_AUTO_PIN: "0",
		COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
		HUSKY: "0",
		HUSKY_SKIP_INSTALL: "1",
		npm_config_audit: "false",
		npm_config_fund: "false",
	};
}

/**
 * Locate an executable on PATH without spawning a shell: Kanban inherits the
 * user's environment and task starts must never pay for shell init (see the
 * repository notes on interactive shells).
 */
export async function findExecutableOnPath(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	fileExists: (candidate: string) => Promise<boolean> = defaultFileExists,
): Promise<string | null> {
	const rawPath = env.PATH ?? env.Path ?? "";
	const entries = rawPath.split(path.delimiter).filter((entry) => entry.trim().length > 0);
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.length > 0)
			: [""];
	for (const entry of entries) {
		for (const extension of extensions) {
			const candidate = path.join(entry, `${name}${extension}`);
			if (await fileExists(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

async function defaultFileExists(candidate: string): Promise<boolean> {
	try {
		await access(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export interface InstallRunResult {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	/** Tail of the combined output, bounded so logs stay readable. */
	output: string;
	error: string | null;
}

const OUTPUT_TAIL_LIMIT = 8_000;

/** Grace period between the kill a package manager can catch and one it cannot. */
const KILL_ESCALATION_MS = 5_000;

/** Run one install command directly (no shell), killing it after `timeoutMs`. */
export function runInstallPlan(
	plan: DependencyInstallPlan,
	options: {
		cwd: string;
		timeoutMs: number;
		env?: NodeJS.ProcessEnv;
		killProcessTree?: (pid: number, signal?: string, callback?: (error?: Error) => void) => void;
		killEscalationMs?: number;
	},
): Promise<InstallRunResult> {
	const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), ...plan.env };
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(plan.command, plan.args, {
				cwd: options.cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			resolve({ ok: false, exitCode: null, timedOut: false, output: "", error: getGitCommandErrorMessage(error) });
			return;
		}
		let output = "";
		let timedOut = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		/** The kill a package manager cannot catch, for a tree that ignored SIGTERM. */
		const forceKillTree = (): void => {
			if (child.pid === undefined) {
				child.kill("SIGKILL");
				return;
			}
			try {
				(options.killProcessTree ?? treeKill)(child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const append = (chunk: Buffer | string): void => {
			output = (output + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT);
		};
		child.stdout?.on("data", (chunk: Buffer | string) => append(chunk));
		child.stderr?.on("data", (chunk: Buffer | string) => append(chunk));
		const timer = setTimeout(() => {
			timedOut = true;
			// The repo-wide convention: tree-kill the child PID, falling back to a
			// direct kill.
			terminateProcessForTimeout(child, { killProcessTree: options.killProcessTree });
			// An installer that shields itself (or its hook scripts) from SIGTERM
			// would otherwise hold the task launch open forever, so escalate to a
			// kill that cannot be caught.
			escalation = setTimeout(forceKillTree, options.killEscalationMs ?? KILL_ESCALATION_MS);
		}, options.timeoutMs);
		const clearTimers = (): void => {
			clearTimeout(timer);
			if (escalation !== undefined) {
				clearTimeout(escalation);
			}
		};
		child.on("error", (error: Error) => {
			clearTimers();
			resolve({ ok: false, exitCode: null, timedOut, output, error: error.message });
		});
		child.on("close", (code) => {
			clearTimers();
			if (timedOut) {
				resolve({
					ok: false,
					exitCode: null,
					timedOut,
					output,
					error: `Install timed out after ${Math.round(options.timeoutMs / 1000)}s.`,
				});
				return;
			}
			resolve({
				ok: code === 0,
				exitCode: code,
				timedOut,
				output,
				error: code === 0 ? null : `${plan.command} ${plan.args.join(" ")} exited with code ${code ?? "null"}.`,
			});
		});
	});
}
