// AR-3 — the `validation_job` tool exposed to native local Cline sessions.
//
// One tool, one job service per session. The model gets a bounded receipt on
// start and can poll status, page the retained log with a byte cursor, and
// cancel. The tool never blocks: every action returns the current state.
import { randomUUID } from "node:crypto";

import type { AgentTool, AgentToolContext } from "@clinebot/shared";

import {
	VALIDATION_JOB_READ_PAGE_BYTES,
	VALIDATION_JOB_TOOL_NAME,
	type ValidationJobLogPage,
	type ValidationJobRecord,
	type ValidationJobService,
	type ValidationJobStartResult,
} from "./validation-job-service";

export { VALIDATION_JOB_TOOL_NAME } from "./validation-job-service";

/**
 * Capability wording appended to the session system prompt, and only when the
 * tool is actually registered in that session (local runtime hosts only).
 * The stable text doubles as the idempotency marker when a session restarts
 * from a persisted launch config.
 */
export const VALIDATION_JOB_CAPABILITY_TEXT = [
	"For validation likely to outlast run_commands, start a validation_job and use its job ID to check status and read the retained log. Check the recorded exit status before reporting success. Inspect another log range instead of rerunning an unchanged check only to obtain a different excerpt. Rerun after relevant changes or when deliberately checking flakiness. Do not start a duplicate while its job is still running.",
].join("\n");

const VALIDATION_JOB_TOOL_DESCRIPTION = [
	"Start and observe long-running validation commands as owned background jobs.",
	"Actions: start (one executable plus one string of args, optional worktree-relative cwd), status, read (page the retained log by byte offset), cancel.",
	"Use this for checks that may outlast run_commands' 30-second limit (builds, full test suites, long network jobs).",
	"Start returns immediately with a job ID; poll status later instead of blocking.",
	"Only one job runs at a time per task; a second, different start while one is running returns a busy result.",
	"The recorded exit status is the real result: a nonzero exit is a failed check even if the log text looks fine.",
	"read pages at most 8192 bytes per call; pass offset (the previous nextOffset) to continue.",
].join("\n");

const VALIDATION_JOB_INPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["start", "status", "read", "cancel"],
			description: "Which action to perform.",
		},
		command: {
			type: "string",
			description: "Executable to run (required for start). No shell parsing; use args for its arguments.",
		},
		args: {
			type: "string",
			description: "Arguments as one string, whitespace- and quote-separated (for start).",
		},
		cwd: {
			type: "string",
			description: "Worktree-relative working directory (for start; default is the worktree root).",
		},
		jobId: {
			type: "string",
			description: "Job ID returned by start (required for status, read, and cancel).",
		},
		offset: {
			type: "number",
			description: "Byte offset into the retained log (for read; default 0).",
		},
		limit: {
			type: "number",
			description: `Maximum bytes to return (for read; capped at ${VALIDATION_JOB_READ_PAGE_BYTES}).`,
		},
	},
	required: ["action"],
	additionalProperties: false,
};

interface ValidationJobToolInput {
	action?: string;
	command?: string;
	args?: string;
	cwd?: string;
	jobId?: string;
	offset?: number;
	limit?: number;
}

function formatCommand(record: ValidationJobRecord): string {
	return [record.command, ...record.args].join(" ");
}

function formatBytes(bytes: number): string {
	return `${bytes.toLocaleString("en-US")} bytes`;
}

function renderRecordHeader(record: ValidationJobRecord): string {
	const lines: string[] = [
		`Validation job ${record.jobId}`,
		`State: ${record.state}`,
		`Command: ${formatCommand(record)}`,
		`Cwd: ${record.cwd || "."}`,
		`Started: ${record.startedAt}`,
	];
	if (record.endedAt) {
		lines.push(`Ended: ${record.endedAt}`);
	}
	if (record.exitCode !== null) {
		lines.push(`Exit code: ${record.exitCode}`);
	}
	if (record.signal) {
		lines.push(`Signal: ${record.signal}`);
	}
	lines.push(
		`Log: ${formatBytes(record.logBytesRetained)} retained, ${formatBytes(record.logBytesOmitted)} omitted (truncated: ${record.logTruncated ? "yes" : "no"})`,
	);
	if (record.artifactPath) {
		lines.push(`Archived log: ${record.artifactPath}`);
	}
	return lines.join("\n");
}

function renderVerdict(record: ValidationJobRecord): string {
	switch (record.state) {
		case "running":
			return "Still running; poll status again later (do not block and do not start a duplicate).";
		case "exited":
			return record.exitCode === 0
				? "Result: the check passed (exit code 0)."
				: `Result: the check FAILED (exit code ${record.exitCode}).`;
		case "canceled":
			return "The job was canceled before it finished; no check result.";
		case "timed_out":
			return "The job hit its 30-minute deadline and was killed; no check result.";
		case "spawn_failed":
			return "The job never started (the executable could not be spawned); no check result.";
		case "interrupted":
			return "The job was interrupted by a runtime restart; the outcome is unknown. Never assume it passed.";
		default:
			return `State ${record.state}: no check result.`;
	}
}

function renderStartResult(result: ValidationJobStartResult): string {
	switch (result.kind) {
		case "started":
			return [
				renderRecordHeader(result.record),
				"",
				`Next: call validation_job with action "status" and job ID ${result.record.jobId} to check progress, or action "read" to page the retained log.`,
			].join("\n");
		case "duplicate":
			return [
				`Duplicate start ignored: this tool call already started job ${result.record.jobId}; no second process was started.`,
				"",
				renderRecordHeader(result.record),
				"",
				renderVerdict(result.record),
			].join("\n");
		case "reused":
			return [
				`A validation job with the same command is already running; returning its receipt instead of starting another.`,
				"",
				renderRecordHeader(result.record),
				"",
				renderVerdict(result.record),
			].join("\n");
		case "busy":
			return [
				`Cannot start: another validation job is already running for this task (job ${result.running.jobId}, command: ${formatCommand(result.running)}).`,
				`Wait for it to finish (action "status") or cancel it (action "cancel") before starting a new one.`,
			].join("\n");
		case "denied":
			return `Validation job start was denied by the tool policy: ${result.reason}`;
		case "invalid":
			return `Invalid validation_job start input: ${result.reason}`;
		case "spawn_failed":
			return `Validation job ${result.record.jobId} failed to spawn: ${result.error}. No process is running and no log was retained.`;
		default:
			return "Unknown validation_job start result.";
	}
}

function renderStatus(record: ValidationJobRecord): string {
	return [renderRecordHeader(record), "", renderVerdict(record)].join("\n");
}

function renderLogPage(jobId: string, page: ValidationJobLogPage): string {
	const lines: string[] = [
		`Log for job ${jobId}, bytes ${page.offset}-${page.nextOffset > 0 ? page.nextOffset - 1 : page.offset} of ${page.totalRetainedBytes} retained:`,
	];
	lines.push(page.text);
	if (page.logTruncated) {
		lines.push(
			`Note: this log is NOT complete — ${formatBytes(page.logBytesOmitted)} trailing bytes exceeded the spool limit and were discarded.`,
		);
	}
	if (!page.complete) {
		lines.push(`Next page: call validation_job read with offset ${page.nextOffset}.`);
	} else {
		lines.push("End of retained log.");
	}
	return lines.join("\n");
}

function renderCancel(record: ValidationJobRecord): string {
	if (record.state === "canceled") {
		return [renderRecordHeader(record), "", "The job was canceled; no check result."].join("\n");
	}
	return [
		renderRecordHeader(record),
		"",
		"The job already finished; nothing was canceled.",
		"",
		renderVerdict(record),
	].join("\n");
}

export function createValidationJobTool(service: ValidationJobService): AgentTool {
	return {
		name: VALIDATION_JOB_TOOL_NAME,
		description: VALIDATION_JOB_TOOL_DESCRIPTION,
		inputSchema: VALIDATION_JOB_INPUT_SCHEMA,
		execute: async (rawInput: unknown, context: AgentToolContext): Promise<string> => {
			const input: ValidationJobToolInput =
				typeof rawInput === "object" && rawInput !== null ? (rawInput as ValidationJobToolInput) : {};
			const action = typeof input.action === "string" ? input.action.trim() : "";
			if (action === "start") {
				const command = typeof input.command === "string" ? input.command : "";
				const args = typeof input.args === "string" ? input.args : "";
				const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
				const toolCallId = context.toolCallId ?? `validation-job-${randomUUID()}`;
				return renderStartResult(
					await service.start({ toolCallId, command, args, ...(cwd !== undefined ? { cwd } : {}) }),
				);
			}
			if (action !== "status" && action !== "read" && action !== "cancel") {
				throw new Error(`Unsupported validation_job action "${action}". Use start, status, read, or cancel.`);
			}
			const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
			if (!jobId) {
				throw new Error("status, read, and cancel require the jobId returned by a start action.");
			}
			if (action === "status") {
				const record = await service.getJob(jobId);
				if (!record) {
					throw new Error(`Unknown validation job "${jobId}" for this task.`);
				}
				return renderStatus(record);
			}
			if (action === "read") {
				const offset =
					typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0
						? input.offset
						: 0;
				const limit =
					typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
						? input.limit
						: undefined;
				const page = await service.readJobLog(jobId, offset, limit);
				if (!page) {
					throw new Error(`Unknown validation job "${jobId}" for this task.`);
				}
				return renderLogPage(jobId, page);
			}
			if (action === "cancel") {
				const record = await service.cancelJob(jobId);
				if (!record) {
					throw new Error(`Unknown validation job "${jobId}" for this task.`);
				}
				return renderCancel(record);
			}
			throw new Error(`Unsupported validation_job action "${action}". Use start, status, read, or cancel.`);
		},
	};
}
