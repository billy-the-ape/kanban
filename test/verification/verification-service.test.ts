// B-7.2 / B-7.3 / B-7.4 — unit tests for the deterministic verification gate
// (VerificationService).
//
// Runs real spawned `node` checks against temp worktrees. The tree-hash
// computation is injected for the deterministic receipt semantics, and a real
// git worktree is used for the tree-identity re-run behaviour (B-7.4).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RuntimeVerificationCheck, RuntimeVerificationConfig } from "../../src/core/api-contract";
import { createVerificationRunner, VerificationService } from "../../src/verification/verification-service";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function makeCheck(overrides: Partial<RuntimeVerificationCheck> = {}): RuntimeVerificationCheck {
	return {
		id: "check-1",
		command: "node",
		args: ["-e", "console.log('ok')"],
		successExitCodes: [0],
		required: true,
		...overrides,
	};
}

function makeConfig(checks: RuntimeVerificationCheck[]): RuntimeVerificationConfig {
	return { enabled: "required", checks };
}

/** A service whose tree identity is a fixed constant (deterministic receipts). */
function makeFakeHashService(hash = "tree-hash-1"): VerificationService {
	return new VerificationService({ computeTreeHash: async () => hash });
}

function makeInput(options: {
	worktreePath: string;
	candidateTreeHash?: string | null;
	logDir?: string;
	signal?: AbortSignal;
}) {
	return {
		taskId: "task-1",
		worktreePath: options.worktreePath,
		candidateTreeHash: options.candidateTreeHash === undefined ? "tree-hash-1" : options.candidateTreeHash,
		...(options.logDir ? { logDir: options.logDir } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	};
}

describe("VerificationService receipt semantics (injected tree hash)", () => {
	it("passes when every required check exits with a success code and the tree is unmutated", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-pass-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck({ args: ["-e", "console.log('all good')"] })]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.passed).toBe(true);
			expect(receipt.error).toBeNull();
			expect(receipt.treeHashBefore).toBe("tree-hash-1");
			expect(receipt.treeHashAfter).toBe("tree-hash-1");
			expect(receipt.treeIdentityPreserved).toBe(true);
			expect(receipt.matchesCandidate).toBe(true);
			expect(receipt.checks).toHaveLength(1);
			const check = receipt.checks[0];
			expect(check.status).toBe("passed");
			expect(check.exitCode).toBe(0);
			expect(check.emptyOutput).toBe(false);
			expect(check.outputExcerpt).toContain("all good");
			expect(check.error).toBeNull();
			expect(check.logPath).not.toBeNull();
			expect(receipt.finishedAt).toBeGreaterThanOrEqual(receipt.startedAt);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("fails the gate when a required check exits with a non-success code", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-fail-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck({ args: ["-e", "console.error('boom'); process.exit(3);"] })]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.passed).toBe(false);
			expect(receipt.checks[0].status).toBe("failed");
			expect(receipt.checks[0].exitCode).toBe(3);
			expect(receipt.checks[0].error).toMatch(/exit code 3/);
			expect(receipt.error).toMatch(/required check "check-1" failed: exit code 3/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("honors custom successExitCodes", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-exitcodes-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						args: ["-e", "process.exit(3);"],
						successExitCodes: [3],
					}),
				]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[0].status).toBe("passed");
			expect(receipt.passed).toBe(true);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("does not block the gate when only an optional check fails", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-optional-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([
					makeCheck(),
					makeCheck({
						id: "optional-check",
						args: ["-e", "process.exit(1);"],
						required: false,
					}),
				]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[1].status).toBe("failed");
			expect(receipt.passed).toBe(true);
			expect(receipt.error).toBeNull();
		} finally {
			cleanupLog();
			cleanup();
		}
	});
});

describe("VerificationService receipt binding", () => {
	it("never passes when the tree identity cannot be computed", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-nohash-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = new VerificationService({ computeTreeHash: async () => null });
			const receipt = await service.run(makeConfig([makeCheck()]), makeInput({ worktreePath: worktree, logDir }));

			expect(receipt.checks[0].status).toBe("passed");
			expect(receipt.treeIdentityPreserved).toBe(false);
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/tree identity could not be computed/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("binds the receipt to the candidate tree via matchesCandidate", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-candidate-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService("tree-hash-1");
			const input = makeInput({ worktreePath: worktree, logDir });

			const matched = await service.run(makeConfig([makeCheck()]), input);
			expect(matched.matchesCandidate).toBe(true);

			const different = await service.run(makeConfig([makeCheck()]), {
				...input,
				candidateTreeHash: "other-hash",
			});
			expect(different.matchesCandidate).toBe(false);

			const unknown = await service.run(makeConfig([makeCheck()]), {
				...input,
				candidateTreeHash: null,
			});
			expect(unknown.matchesCandidate).toBe(false);
		} finally {
			cleanupLog();
			cleanup();
		}
	});
});

describe("VerificationService spawned check behaviour", () => {
	it("writes a per-check log artifact and captures output", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-log-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(makeConfig([makeCheck()]), makeInput({ worktreePath: worktree, logDir }));

			const logPath = receipt.checks[0].logPath;
			expect(logPath).not.toBeNull();
			expect(logPath).toContain(logDir);
			expect(existsSync(logPath ?? "")).toBe(true);
			const log = readFileSync(logPath ?? "", "utf8");
			expect(log).toContain("check: check-1");
			expect(log).toContain("attempt: 1");
			expect(log).toContain("command: node");
			expect(log).toContain("ok");
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("truncates the receipt excerpt and caps the log file for huge output", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-truncate-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						args: ["-e", "process.stdout.write('a'.repeat(3 * 1024 * 1024));"],
					}),
				]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.passed).toBe(true);
			expect(receipt.checks[0].outputExcerpt.length).toBeLessThanOrEqual(256 * 1024);
			const logPath = receipt.checks[0].logPath;
			expect(logPath).not.toBeNull();
			const logSize = statSync(logPath ?? "").size;
			expect(logSize).toBeLessThanOrEqual(1024 * 1024 + 1024);
			expect(logSize).toBeGreaterThan(1024 * 1024);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("reports timeout when a check runs past its timeoutMs", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-timeout-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						args: ["-e", "setTimeout(() => {}, 120000);"],
						timeoutMs: 500,
					}),
				]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[0].status).toBe("timeout");
			expect(receipt.checks[0].error).toMatch(/exceeded the 500 ms timeout/);
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/required check "check-1" timeout: exceeded the 500 ms timeout/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("reports missing_executable when the command does not exist", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-missing-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck({ command: "definitely-not-a-real-binary-xyz", args: [] })]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[0].status).toBe("missing_executable");
			expect(receipt.checks[0].emptyOutput).toBe(true);
			expect(receipt.checks[0].logPath).not.toBeNull();
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/missing_executable/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("reports cancelled when the signal is already aborted", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-preabort-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const controller = new AbortController();
			controller.abort();
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck()]),
				makeInput({ worktreePath: worktree, logDir, signal: controller.signal }),
			);

			expect(receipt.checks[0].status).toBe("cancelled");
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/cancelled/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("kills an in-flight check when the signal aborts", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-abort-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 300);
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck({ args: ["-e", "setTimeout(() => {}, 120000);"] })]),
				makeInput({ worktreePath: worktree, logDir, signal: controller.signal }),
			);
			clearTimeout(timer);

			expect(receipt.checks[0].status).toBe("cancelled");
			expect(receipt.passed).toBe(false);
		} finally {
			cleanupLog();
			cleanup();
		}
	});
});

describe("VerificationService check working directory", () => {
	it("rejects a cwd that escapes the worktree with `..`", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-cwd-escape-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck({ cwd: "../outside" })]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[0].status).toBe("error");
			expect(receipt.checks[0].error).toMatch(/working directory/);
			expect(receipt.passed).toBe(false);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("rejects an absolute cwd", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-cwd-abs-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([makeCheck({ cwd: "/etc" })]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[0].status).toBe("error");
			expect(receipt.passed).toBe(false);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("runs a check with a relative cwd inside the worktree", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-cwd-rel-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			mkdirSync(join(worktree, "sub"));
			writeFileSync(join(worktree, "sub", "marker.txt"), "here");
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						cwd: "sub",
						args: ["-e", "console.log(require('fs').existsSync('marker.txt'))"],
					}),
				]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			expect(receipt.checks[0].status).toBe("passed");
			expect(receipt.checks[0].outputExcerpt).toContain("true");
			expect(receipt.passed).toBe(true);
		} finally {
			cleanupLog();
			cleanup();
		}
	});
});

describe("VerificationService check environment", () => {
	it("applies the configured env on top of the base allowlist only", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-env-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		const secretKey = "KANBAN_VERIFICATION_SECRET_TEST";
		const previous = process.env[secretKey];
		process.env[secretKey] = "leak";
		try {
			const service = makeFakeHashService();
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						args: [
							"-e",
							`console.log('MY_VAR=' + process.env.MY_VAR); console.log('SECRET=' + (process.env.${secretKey} ?? 'absent')); console.log('PATH_SET=' + (process.env.PATH ? 'yes' : 'no'));`,
						],
						env: { MY_VAR: "hello" },
					}),
				]),
				makeInput({ worktreePath: worktree, logDir }),
			);

			const excerpt = receipt.checks[0].outputExcerpt;
			expect(excerpt).toContain("MY_VAR=hello");
			expect(excerpt).toContain("SECRET=absent");
			expect(excerpt).toContain("PATH_SET=yes");
		} finally {
			if (previous === undefined) {
				delete process.env[secretKey];
			} else {
				process.env[secretKey] = previous;
			}
			cleanupLog();
			cleanup();
		}
	});
});

describe("VerificationService tree identity re-run (B-7.4)", () => {
	function initGitWorktree(path: string): void {
		execFileSync("git", ["init", "-q"], { cwd: path, env: createGitTestEnv() });
	}

	it("re-runs once when an idempotent check generates files, then passes", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-mutation-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			initGitWorktree(worktree);
			writeFileSync(join(worktree, "a.txt"), "a");
			const service = new VerificationService(); // real tree hash
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						id: "gen",
						args: ["-e", "require('fs').writeFileSync('generated.txt', 'x');"],
					}),
				]),
				makeInput({ worktreePath: worktree, candidateTreeHash: null, logDir }),
			);

			expect(receipt.treeIdentityPreserved).toBe(true);
			expect(receipt.passed).toBe(true);
			expect(receipt.error).toBeNull();
			// The first attempt mutated the tree, so both attempt logs exist.
			const logs = readdirSync(logDir);
			expect(logs.filter((file) => file.includes("attempt1")).length).toBe(1);
			expect(logs.filter((file) => file.includes("attempt2")).length).toBe(1);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("still fails when the re-run mutates the tree again", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-mutation2-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			initGitWorktree(worktree);
			writeFileSync(join(worktree, "a.txt"), "a");
			const service = new VerificationService(); // real tree hash
			const receipt = await service.run(
				makeConfig([
					makeCheck({
						id: "gen",
						args: ["-e", "require('fs').writeFileSync('rand.txt', Math.random().toString(36));"],
					}),
				]),
				makeInput({ worktreePath: worktree, candidateTreeHash: null, logDir }),
			);

			expect(receipt.treeIdentityPreserved).toBe(false);
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/mutated the worktree/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});

	it("fails to bind when the worktree is not a git repository", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-nogit-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			writeFileSync(join(worktree, "a.txt"), "a");
			const service = new VerificationService(); // real tree hash
			const receipt = await service.run(
				makeConfig([makeCheck()]),
				makeInput({ worktreePath: worktree, candidateTreeHash: null, logDir }),
			);

			expect(receipt.checks[0].status).toBe("passed");
			expect(receipt.treeIdentityPreserved).toBe(false);
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/tree identity could not be computed/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});
});

describe("createVerificationRunner", () => {
	it("exposes the default spawn-based runner through the VerificationRunner seam", async () => {
		const { path: worktree, cleanup } = createTempDir("kanban-verification-runner-");
		const { path: logDir, cleanup: cleanupLog } = createTempDir("kanban-verification-logs-");
		try {
			const runner = createVerificationRunner();
			const receipt = await runner.run(
				makeConfig([makeCheck()]),
				makeInput({ worktreePath: worktree, candidateTreeHash: null, logDir }),
			);

			expect(receipt.checks[0].status).toBe("passed");
			// Temp dir is not a git worktree, so the run cannot be bound.
			expect(receipt.passed).toBe(false);
			expect(receipt.error).toMatch(/tree identity could not be computed/);
		} finally {
			cleanupLog();
			cleanup();
		}
	});
});
