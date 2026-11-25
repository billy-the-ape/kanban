import { describe, expect, it, vi } from "vitest";

import { runInstallPlan } from "../../src/workspace/dependencies/install-plan";
import type { DependencyInstallPlan } from "../../src/workspace/dependencies/types";

/** A process that catches SIGTERM and stays alive, like a hooked install can. */
const STUBBORN_SCRIPT =
	"require('node:net').createServer().listen(0);process.on('SIGTERM',()=>{});console.log(process.pid);";

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stubbornInstaller(): DependencyInstallPlan {
	return { command: process.execPath, args: ["-e", STUBBORN_SCRIPT], env: {} };
}

describe("runInstallPlan timeouts", () => {
	// The kill path is POSIX-only: tree-kill shells out to `ps`/`kill`, and
	// Windows terminates the child directly instead.
	it.skipIf(process.platform === "win32")(
		"escalates to a kill a stubborn installer cannot ignore",
		async () => {
			// Without the escalation this never resolves: the child survives SIGTERM,
			// so the install would hold whatever is waiting for it open forever. The
			// timeout has to outlast Node's boot so the child can report its pid.
			const result = await runInstallPlan(stubbornInstaller(), {
				cwd: process.cwd(),
				timeoutMs: 500,
				killEscalationMs: 50,
			});

			expect(result.timedOut).toBe(true);
			expect(result.ok).toBe(false);
			const pid = Number(result.output.trim().split("\n").pop());
			expect(Number.isInteger(pid) && pid > 1, `expected a pid in output: ${result.output}`).toBe(true);
			await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), { timeout: 3_000, interval: 25 });
		},
		15_000,
	);

	it("reports a timeout when the process cannot be spawned at all", async () => {
		const result = await runInstallPlan(
			{ command: "/definitely/not/an/executable", args: [], env: {} },
			{
				cwd: process.cwd(),
				timeoutMs: 5_000,
			},
		);
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(result.error).toContain("/definitely/not/an/executable");
	});
});
