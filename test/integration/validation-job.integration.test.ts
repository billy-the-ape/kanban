// AR-3 — integration: a validation job outlives run_commands' 30-second
// deadline and is observed to completion through the owned job lifecycle.
//
// Gated behind KANBAN_AR3_INTEGRATION=1 because it waits ~35 seconds of real
// time; CI runs the fast unit suites by default.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentModel, AgentRuntime } from "@clinebot/agents";
import { describe, expect, it } from "vitest";
import { createClineToolLoopGuard } from "../../src/cline-sdk/cline-tool-loop-guard";
import { ValidationJobService } from "../../src/cline-sdk/validation-job-service";
import { createValidationJobTool } from "../../src/cline-sdk/validation-job-tool";

describe.runIf(process.env.KANBAN_AR3_INTEGRATION === "1")("AR-3 validation job lifecycle (real time)", () => {
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let homeDir: string;
	let worktreeDir: string;

	it("observes a job beyond the 30-second command deadline", { timeout: 90_000 }, async () => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		homeDir = await mkdtemp(join(tmpdir(), "ar3-int-home-"));
		worktreeDir = await mkdtemp(join(tmpdir(), "ar3-int-worktree-"));
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		try {
			const service = new ValidationJobService({
				taskId: "task-int",
				sessionId: "session-int",
				worktreePath: worktreeDir,
				approve: async () => ({ approved: true }),
			});
			const started = await service.start({
				toolCallId: "call-int",
				command: process.execPath,
				args: '-e "setTimeout(()=>{},35000)"',
			});
			expect(started.kind).toBe("started");
			if (started.kind !== "started") {
				throw new Error("expected started");
			}
			const jobId = started.record.jobId;
			// The job is observable while running...
			const running = await service.getJob(jobId);
			expect(running?.state).toBe("running");
			// Drive repeated identical waits through the real SDK agent loop.
			// This exceeds both the old five-call limit and the command deadline.
			let observations = 0;
			const model: AgentModel = {
				async *stream() {
					if (service.getLiveJob()) {
						if (observations > 80) throw new Error("job did not settle");
						yield {
							type: "tool-call-delta",
							toolCallId: `wait-${observations++}`,
							toolName: "validation_job",
							inputText: JSON.stringify({ action: "wait", jobId, timeoutMs: 1000 }),
						};
						yield { type: "finish", reason: "tool-calls" };
					} else {
						yield { type: "text-delta", text: "Done" };
						yield { type: "finish", reason: "stop" };
					}
				},
			};
			const agent = new AgentRuntime({
				model,
				tools: [createValidationJobTool(service)],
				hooks: createClineToolLoopGuard((id) => service.getLiveJob()?.jobId === id),
			});
			expect((await agent.run("Observe validation")).status).toBe("completed");
			expect(observations).toBeGreaterThan(5);
			const record = await service.getJob(jobId);
			expect(record?.exitCode).toBe(0);
			expect(record?.endedAt).toBeTruthy();
		} finally {
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
			await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});
