// AR-3 — contract tests for the `validation_job` tool.
//
// The tool is a single non-blocking entry point: start returns a bounded
// receipt, status/reporting reads the recorded state, read pages the retained
// log (bounded), and cancel stops the owned job. HOME is redirected so task
// state lives under a temp dir.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationJobService } from "../../src/cline-sdk/validation-job-service";
import { createValidationJobTool, VALIDATION_JOB_CAPABILITY_TEXT } from "../../src/cline-sdk/validation-job-tool";

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let homeDir: string;
let worktreeDir: string;

beforeEach(async () => {
	originalHome = process.env.HOME;
	originalUserProfile = process.env.USERPROFILE;
	homeDir = await mkdtemp(join(tmpdir(), "ar3-tool-home-"));
	worktreeDir = await mkdtemp(join(tmpdir(), "ar3-tool-worktree-"));
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
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
});

function createTool(
	options: { approve?: () => Promise<{ approved: boolean; reason?: string }>; deadlineMs?: number } = {},
) {
	const service = new ValidationJobService({
		taskId: "task-tool",
		sessionId: "session-tool",
		worktreePath: worktreeDir,
		approve: options.approve ?? (async () => ({ approved: true })),
		deadlineMs: options.deadlineMs,
	});
	return { tool: createValidationJobTool(service), service };
}

async function waitState(service: ValidationJobService, jobId: string, state: string, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await service.getJob(jobId);
		if (record && record.state === state) {
			return record;
		}
		if (Date.now() > deadline) {
			throw new Error(`job did not reach state ${state}; last state was ${record?.state ?? "missing"}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("validation_job tool", () => {
	it("exposes the tool contract (name, schema, capability text)", () => {
		const { tool } = createTool();
		expect(tool.name).toBe("validation_job");
		expect(tool.description).toMatch(/start/i);
		const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> };
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties?.action?.enum).toEqual(["start", "status", "wait", "read", "cancel"]);
		expect(VALIDATION_JOB_CAPABILITY_TEXT).toMatch(/validation_job/);
	});

	it("start returns a bounded receipt with a job ID and polling instructions", async () => {
		const { tool } = createTool();
		const output = await tool.execute(
			{ action: "start", command: process.execPath, args: '-e "setTimeout(()=>{},300)"' },
			{ agentId: "agent-1", iteration: 0, toolCallId: "call-start" },
		);
		expect(typeof output).toBe("string");
		const text = output as string;
		expect(text).toMatch(/Validation job /);
		expect(text).toMatch(/State: running/);
		expect(text).toMatch(/job ID/);
		expect(text).toMatch(/action "wait"/);
	});

	it("status reports the real exit status (pass vs fail)", async () => {
		const { tool, service } = createTool();
		await tool.execute(
			{ action: "start", command: process.execPath, args: "-e 1" },
			{
				agentId: "agent-1",
				iteration: 0,
				toolCallId: "call-pass",
			},
		);
		const live = service.getLiveJob();
		const jobId = live?.jobId;
		if (!jobId) {
			throw new Error("expected a live job");
		}
		await waitState(service, jobId, "exited");
		const status = await tool.execute({ action: "status", jobId }, { agentId: "agent-1", iteration: 1 });
		expect(status).toMatch(/Result: the check passed \(exit code 0\)/);
	});

	it("status of a failed check reports the failure with the exit code", async () => {
		const { tool, service } = createTool();
		await tool.execute(
			{ action: "start", command: process.execPath, args: '-e "process.exitCode = 3"' },
			{
				agentId: "agent-1",
				iteration: 0,
				toolCallId: "call-fail",
			},
		);
		const live = service.getLiveJob();
		const jobId = live?.jobId;
		if (!jobId) {
			throw new Error("expected a live job");
		}
		const record = await waitState(service, jobId, "exited");
		const status = await tool.execute({ action: "status", jobId }, { agentId: "agent-1", iteration: 1 });
		expect(status).toMatch(/Result: the check FAILED \(exit code 3\)/);
		void record;
	});

	it("read pages the retained log and bounds each page to the limit", async () => {
		const { tool, service } = createTool();
		await tool.execute(
			{
				action: "start",
				command: process.execPath,
				args: '-e "process.stdout.write(`abcdefghijklmnopqrstuvwxyz`.repeat(24))"',
			},
			{ agentId: "agent-1", iteration: 0, toolCallId: "call-read" },
		);
		const live = service.getLiveJob();
		const jobId = live?.jobId;
		if (!jobId) {
			throw new Error("expected a live job");
		}
		await waitState(service, jobId, "exited");
		const page = await tool.execute({ action: "read", jobId }, { agentId: "agent-1", iteration: 1 });
		expect(page).toMatch(/bytes 0-\d+ of 624 retained/);
		expect(page).not.toContain("Next page");
	});

	it("cancel stops the owned job and reports no check result", async () => {
		const { tool, service } = createTool();
		await tool.execute(
			{ action: "start", command: process.execPath, args: '-e "setTimeout(()=>{},5000)"' },
			{
				agentId: "agent-1",
				iteration: 0,
				toolCallId: "call-cancel",
			},
		);
		const live = service.getLiveJob();
		const jobId = live?.jobId;
		if (!jobId) {
			throw new Error("expected a live job");
		}
		const canceled = await tool.execute({ action: "cancel", jobId }, { agentId: "agent-1", iteration: 1 });
		expect(canceled).toMatch(/State: canceled/);
		expect(canceled).toMatch(/no check result/);
		expect(service.getLiveJob()).toBeNull();
	});

	it("rejects unknown jobs and unsupported actions with actionable errors", async () => {
		const { tool } = createTool();
		await expect(
			tool.execute({ action: "status", jobId: "nope" }, { agentId: "agent-1", iteration: 1 }),
		).rejects.toThrow(/Unknown validation job/);
		await expect(tool.execute({ action: "explode" }, { agentId: "agent-1", iteration: 1 })).rejects.toThrow(
			/Unsupported validation_job action/,
		);
	});

	it("denied starts create no job", async () => {
		const { tool, service } = createTool({
			approve: async () => ({ approved: false, reason: "denied by policy" }),
		});
		const output = await tool.execute(
			{ action: "start", command: process.execPath, args: "-e 1" },
			{
				agentId: "agent-1",
				iteration: 0,
				toolCallId: "call-denied",
			},
		);
		expect(output).toMatch(/denied by the tool policy: denied by policy/);
		expect(service.getLiveJob()).toBeNull();
	});

	it("busy starts explain the running job and how to proceed", async () => {
		const { tool, service } = createTool();
		await tool.execute(
			{ action: "start", command: process.execPath, args: '-e "setTimeout(()=>{},5000)"' },
			{
				agentId: "agent-1",
				iteration: 0,
				toolCallId: "call-busy-1",
			},
		);
		const busy = await tool.execute(
			{ action: "start", command: process.execPath, args: "-e 1" },
			{
				agentId: "agent-1",
				iteration: 1,
				toolCallId: "call-busy-2",
			},
		);
		expect(busy).toMatch(/already running/);
		expect(busy).toMatch(/cancel/);
		const live = service.getLiveJob();
		if (live) {
			await service.cancelJob(live.jobId);
		}
	});
});

describe("validation_job bounded waiting", () => {
	it("supports wait and paces repeated status reads without losing completion", async () => {
		const { tool, service } = createTool();
		const context = { agentId: "agent-1", iteration: 1 };
		try {
			await tool.execute(
				{ action: "start", command: process.execPath, args: '-e "setTimeout(()=>{},60000)"' },
				context,
			);
			const jobId = service.getLiveJob()?.jobId;
			if (!jobId) throw new Error("expected job");
			await tool.execute({ action: "status", jobId }, context);
			const began = Date.now();
			await tool.execute({ action: "status", jobId }, context);
			expect(Date.now() - began).toBeGreaterThanOrEqual(900);
			await expect(tool.execute({ action: "wait", jobId, timeoutMs: 0 }, context)).rejects.toThrow("timeoutMs");
			await expect(tool.execute({ action: "wait", jobId, timeoutMs: 30000 }, context)).rejects.toThrow("timeoutMs");
			const waiting = tool.execute({ action: "wait", jobId }, context);
			await service.cancelJob(jobId);
			expect(await waiting).toContain("State: canceled");
		} finally {
			await service.cancelAllJobs();
		}
	});
});
