// AR-3 — unit tests for the owned validation-job service.
//
// The service owns at most one live process per task, spools its output to an
// owner-only file, and persists a versioned record per job. HOME is
// redirected so the task-state tree (spools, records, artifacts) lives under
// a temp dir instead of the user's real ~/.cline.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getTaskValidationJobsDir,
	VALIDATION_JOB_SCHEMA_VERSION,
	type ValidationJobRecord,
	ValidationJobService,
} from "../../src/cline-sdk/validation-job-service";
import { getTaskContextArtifactsDir } from "../../src/workspace/task-artifacts";

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let homeDir: string;
let worktreeDir: string;
let taskDir: string;

beforeEach(async () => {
	originalHome = process.env.HOME;
	originalUserProfile = process.env.USERPROFILE;
	homeDir = await mkdtemp(join(tmpdir(), "ar3-home-"));
	worktreeDir = await mkdtemp(join(tmpdir(), "ar3-worktree-"));
	taskDir = join(homeDir, ".cline", "worktrees", "task-ar3", "validation-jobs");
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

function createService(
	options: {
		taskId?: string;
		sessionId?: string;
		approve?: (input: {
			toolCallId: string;
			command: string;
			args: string[];
			cwd?: string;
		}) => Promise<{ approved: boolean; reason?: string }>;
		deadlineMs?: number;
		maxLogBytes?: number;
		maxReadBytes?: number;
	} = {},
) {
	return new ValidationJobService({
		taskId: options.taskId ?? "task-ar3",
		sessionId: options.sessionId ?? "session-ar3",
		worktreePath: worktreeDir,
		approve: options.approve ?? (async () => ({ approved: true })),
		deadlineMs: options.deadlineMs,
		maxLogBytes: options.maxLogBytes,
		maxReadBytes: options.maxReadBytes,
	});
}

async function waitForState(
	service: ValidationJobService,
	jobId: string,
	state: string,
	timeoutMs = 15000,
): Promise<ValidationJobRecord> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await service.getJob(jobId);
		if (record === null) {
			throw new Error(`job ${jobId} disappeared while waiting for state ${state}`);
		}
		if (record.state === state) {
			return record;
		}
		if (Date.now() > deadline) {
			throw new Error(`job ${jobId} did not reach state ${state}; last state was ${record.state}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("ValidationJobService.start", () => {
	it("starts one job and settles it with the real exit status", async () => {
		const service = createService();
		const result = await service.start({
			toolCallId: "call-1",
			command: process.execPath,
			args: "-e \"process.stdout.write('line one\\nline two');\"",
		});
		expect(result.kind).toBe("started");
		const started = result.kind === "started" ? result.record : null;
		if (!started) {
			throw new Error("expected a started record");
		}
		expect(started.state).toBe("running");
		expect(started.taskId).toBe("task-ar3");
		expect(started.sessionId).toBe("session-ar3");
		expect(started.toolCallId).toBe("call-1");

		const settled = await waitForState(service, started.jobId, "exited");
		expect(settled.exitCode).toBe(0);
		expect(settled.signal).toBeNull();
		expect(settled.endedAt).toBeTruthy();
		expect(settled.logBytesRetained).toBeGreaterThan(0);
		expect(settled.logTruncated).toBe(false);
		// The retained log is archived through the task context-artifact writer.
		expect(settled.artifactPath).toBeTruthy();
	});

	it("denies before spawning when the approval gate rejects", async () => {
		const service = createService({
			approve: async () => ({ approved: false, reason: "not in this workspace" }),
		});
		const result = await service.start({ toolCallId: "call-2", command: process.execPath, args: "-e 1" });
		expect(result.kind).toBe("denied");
		expect(result.kind === "denied" ? result.reason : "").toContain("not in this workspace");
		// No record is persisted for a denied start.
		expect(await service.getJob("")).toBeNull();
	});

	it("rejects invalid command input without spawning", async () => {
		const service = createService();
		const empty = await service.start({ toolCallId: "call-3", command: "  ", args: "" });
		expect(empty.kind).toBe("invalid");
		const newline = await service.start({ toolCallId: "call-4", command: "echo a\necho b", args: "" });
		expect(newline.kind).toBe("invalid");
		const badArgs = await service.start({ toolCallId: "call-5", command: "echo", args: '"unbalanced' });
		expect(badArgs.kind).toBe("invalid");
	});

	it("keeps exactly one live job: a different command reports busy, an identical one is reused", async () => {
		const service = createService();
		const first = await service.start({
			toolCallId: "call-6",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},300)"',
		});
		expect(first.kind).toBe("started");
		if (first.kind !== "started") {
			throw new Error("expected started");
		}
		const busy = await service.start({ toolCallId: "call-7", command: process.execPath, args: "-e 1" });
		expect(busy.kind).toBe("busy");
		if (busy.kind !== "busy") {
			throw new Error("expected busy");
		}
		expect(busy.running.jobId).toBe(first.record.jobId);
		const duplicate = await service.start({
			toolCallId: "call-6",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},300)"',
		});
		expect(duplicate.kind).toBe("duplicate");
		// The single live job is still the first one.
		const live = service.getLiveJob();
		expect(live?.jobId).toBe(first.record.jobId);
		const settled = await waitForState(service, first.record.jobId, "exited");
		expect(settled.exitCode).toBe(0);
	});

	it("settles spawn failures without leaving a live job", async () => {
		const service = createService();
		const result = await service.start({
			toolCallId: "call-8",
			command: "definitely-not-a-real-binary-xyz",
			args: "",
		});
		expect(result.kind).toBe("spawn_failed");
		expect(service.getLiveJob()).toBeNull();
		if (result.kind !== "spawn_failed") {
			throw new Error("expected spawn_failed");
		}
		expect(result.record.state).toBe("spawn_failed");
		const settled = await waitForState(service, result.record.jobId, "spawn_failed");
		expect(settled.state).toBe("spawn_failed");
	});

	it("kills the owned job on cancel and reports the canceled state", async () => {
		const service = createService();
		const started = await service.start({
			toolCallId: "call-9",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},5000)"',
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const canceled = await service.cancelJob(started.record.jobId);
		expect(canceled?.state).toBe("canceled");
		expect(service.getLiveJob()).toBeNull();
		// A cancel of an already-settled job returns the record unchanged.
		const again = await service.cancelJob(started.record.jobId);
		expect(again?.state).toBe("canceled");
	});

	it("kills the job when its deadline passes", async () => {
		const service = createService({ deadlineMs: 300 });
		const started = await service.start({
			toolCallId: "call-10",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},5000)"',
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const settled = await waitForState(service, started.record.jobId, "timed_out", 15000);
		expect(settled.state).toBe("timed_out");
		expect(settled.timedOut).toBe(true);
		expect(service.getLiveJob()).toBeNull();
	});

	it("truncates the spool at the retention limit and reports the omission", async () => {
		const service = createService({ maxLogBytes: 1024 });
		const started = await service.start({
			toolCallId: "call-11",
			command: process.execPath,
			args: '-e "process.stdout.write(`x`.repeat(65536))"',
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const settled = await waitForState(service, started.record.jobId, "exited");
		expect(settled.exitCode).toBe(0);
		expect(settled.logTruncated).toBe(true);
		expect(settled.logBytesRetained).toBeLessThanOrEqual(1024);
		expect(settled.logBytesOmitted).toBeGreaterThan(0);
		const page = await service.readJobLog(started.record.jobId);
		expect(page?.logTruncated).toBe(true);
		expect(page?.logBytesOmitted).toBeGreaterThan(0);
	});

	it("scopes the working directory to an existing worktree subdirectory", async () => {
		const sub = join(worktreeDir, "sub");
		await mkdir(sub, { recursive: true });
		const service = createService();
		const outside = await service.start({
			toolCallId: "call-12",
			command: process.execPath,
			args: "-e 1",
			cwd: "../..",
		});
		expect(outside.kind).toBe("invalid");
		const absolute = await service.start({
			toolCallId: "call-13",
			command: process.execPath,
			args: "-e 1",
			cwd: "/etc",
		});
		expect(absolute.kind).toBe("invalid");
		const ok = await service.start({
			toolCallId: "call-14",
			command: process.execPath,
			args: '-e "process.stdout.write(process.cwd())"',
			cwd: "sub",
		});
		expect(ok.kind).toBe("started");
		if (ok.kind !== "started") {
			throw new Error("expected started");
		}
		expect(ok.record.cwd).toBe("sub");
		await waitForState(service, ok.record.jobId, "exited");
		const page = await service.readJobLog(ok.record.jobId);
		expect(page?.text).toBe(sub);
	});
});

describe("ValidationJobService log paging", () => {
	it("pages the retained log with a byte cursor bounded to the page limit", async () => {
		const service = createService({ maxReadBytes: 64 });
		const started = await service.start({
			toolCallId: "call-15",
			command: process.execPath,
			args: '-e "process.stdout.write(`abcdefghijklmnopqrstuvwxyz`.repeat(24))"',
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const jobId = started.record.jobId;
		await waitForState(service, jobId, "exited");
		const first = await service.readJobLog(jobId);
		if (!first) {
			throw new Error("expected a log page");
		}
		expect(first.text.length).toBeLessThanOrEqual(64);
		expect(first.complete).toBe(false);
		expect(first.nextOffset).toBeGreaterThan(0);
		const second = await service.readJobLog(jobId, first.nextOffset);
		if (!second) {
			throw new Error("expected a second log page");
		}
		expect(second.offset).toBe(first.nextOffset);
		expect(first.text + second.text).toContain("abcdefghijklmnopqrstuvwxyz");
		const tail = await service.readJobLog(jobId, 2048);
		if (!tail) {
			throw new Error("expected a tail page");
		}
		expect(tail.complete).toBe(true);
		expect(tail.text).toBe("");
	});
});

describe("ValidationJobService crash adoption", () => {
	it("reclassifies a retained running record as interrupted on the next adoption and never resumes it", async () => {
		await mkdir(taskDir, { recursive: true });
		const orphan: ValidationJobRecord = {
			schemaVersion: VALIDATION_JOB_SCHEMA_VERSION,
			taskId: "task-ar3",
			sessionId: "session-old",
			jobId: "0f9619ff-8b86-4d01-a22b-0f6d3e8b7f1a",
			toolCallId: "call-old",
			command: process.execPath,
			args: ["-e", "1"],
			cwd: "",
			startedAt: new Date().toISOString(),
			endedAt: null,
			state: "running",
			exitCode: null,
			signal: null,
			timedOut: false,
			canceled: false,
			logTruncated: false,
			logBytesRetained: 0,
			logBytesOmitted: 0,
			artifactPath: null,
		};
		await writeFile(join(taskDir, "0f9619ff-8b86-4d01-a22b-0f6d3e8b7f1a.json"), JSON.stringify(orphan, null, 2));

		const service = createService();
		await service.initialize();
		const adopted = await service.getJob("0f9619ff-8b86-4d01-a22b-0f6d3e8b7f1a");
		expect(adopted?.state).toBe("interrupted");
		expect(adopted?.endedAt).toBeTruthy();

		// Adoption is idempotent and leaves settled records alone.
		const second = new ValidationJobService({
			taskId: "task-ar3",
			sessionId: "session-newer",
			worktreePath: worktreeDir,
			approve: async () => ({ approved: true }),
		});
		await second.initialize();
		const still = await second.getJob("0f9619ff-8b86-4d01-a22b-0f6d3e8b7f1a");
		expect(still?.state).toBe("interrupted");
	});

	it("settles a replaced session's live job as canceled before a successor adopts it", async () => {
		const previous = createService({ sessionId: "session-a" });
		const started = await previous.start({
			toolCallId: "call-16",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},5000)"',
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		// The runtime cancels the replaced session's jobs before the successor
		// service adopts the retained records, so the job settles as canceled,
		// never as interrupted, and is never re-resumed.
		const settled = await previous.cancelAllJobs();
		expect(settled[0]?.state).toBe("canceled");
		const successor = createService({ sessionId: "session-b" });
		await successor.initialize();
		const record = await successor.getJob(started.record.jobId);
		expect(record?.state).toBe("canceled");
	});
});

describe("ValidationJobService file hygiene", () => {
	it("writes owner-only spools and records under the task's validation-jobs dir", async () => {
		const service = createService();
		const started = await service.start({
			toolCallId: "call-17",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},200)"',
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const dir = getTaskValidationJobsDir("task-ar3");
		expect(dir).toBe(taskDir);
		const recordStat = await readFile(join(dir, `${started.record.jobId}.json`), "utf8");
		expect(recordStat).toContain('"state"');
		// The spool exists while the job is live and is owner-only.
		const spool = join(dir, `${started.record.jobId}.log`);
		expect((await stat(spool)).mode & 0o777).toBe(0o600);
		await waitForState(service, started.record.jobId, "exited");
		// After settlement the spool is archived and removed.
		await stat(spool).then(
			() => {
				throw new Error("spool should be removed after settlement");
			},
			() => undefined,
		);
	});
});

describe("ValidationJobService review hardening", () => {
	it("rejects traversal-shaped and unknown job ids without touching the filesystem", async () => {
		const service = createService();
		expect(await service.getJob("../../../../etc/passwd")).toBeNull();
		expect(await service.getJob("nope")).toBeNull();
		expect(await service.cancelJob("../up")).toBeNull();
		expect(await service.readJobLog("../../../../etc/passwd")).toBeNull();
	});

	it("never opens a forged record's artifact path outside the task's artifact dir", async () => {
		await mkdir(taskDir, { recursive: true });
		const secret = join(worktreeDir, "secret.txt");
		await writeFile(secret, "top secret");
		const forgedId = "11111111-2222-4333-8444-555555555555";
		const forged: ValidationJobRecord = {
			schemaVersion: VALIDATION_JOB_SCHEMA_VERSION,
			taskId: "task-ar3",
			sessionId: "session-old",
			jobId: forgedId,
			toolCallId: "call-forged",
			command: "true",
			args: [],
			cwd: "",
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			state: "exited",
			exitCode: 0,
			signal: null,
			timedOut: false,
			canceled: false,
			logTruncated: false,
			logBytesRetained: 0,
			logBytesOmitted: 0,
			artifactPath: secret,
		};
		await writeFile(join(taskDir, `${forgedId}.json`), JSON.stringify(forged, null, 2));
		const service = createService();
		// The record's metadata is readable (it is this task's record)...
		const record = await service.getJob(forgedId);
		expect(record?.state).toBe("exited");
		// ...but the log read refuses the forged artifact path.
		const page = await service.readJobLog(forgedId);
		expect(page?.text).toBe("");
		expect(page?.totalRetainedBytes).toBe(0);
	});

	it("does not report a settled state before archival completes", async () => {
		const service = new ValidationJobService({
			taskId: "task-ar3",
			sessionId: "session-ar3",
			worktreePath: worktreeDir,
			approve: async () => ({ approved: true }),
			archiveArtifact: async () => {
				// Hold archival so the settle window is observable.
				await new Promise((resolve) => setTimeout(resolve, 150));
				return join(homeDir, ".cline", "worktrees", "task-ar3", "context-artifacts", "held.txt");
			},
		});
		const started = await service.start({
			toolCallId: "call-settle-race",
			command: process.execPath,
			args: "-e \"process.stdout.write('output')\"",
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const settled = await waitForState(service, started.record.jobId, "exited");
		// Observing `exited` implies the archive reference and retained bytes
		// are already final (single synchronous publication).
		expect(settled.artifactPath).toBeTruthy();
		expect(settled.logBytesRetained).toBeGreaterThan(0);
	});

	it("serializes concurrent starts so at most one job is spawned", async () => {
		const service = createService();
		const [first, second] = await Promise.all([
			service.start({ toolCallId: "call-race-1", command: process.execPath, args: '-e "setTimeout(()=>{},500)"' }),
			service.start({ toolCallId: "call-race-2", command: process.execPath, args: "-e 1" }),
		]);
		const kinds = [first.kind, second.kind].sort();
		expect(kinds).toEqual(["busy", "started"]);
		const started = first.kind === "started" ? first : second;
		if (started.kind !== "started") {
			throw new Error("expected one started result");
		}
		expect(service.getLiveJob()?.jobId).toBe(started.record.jobId);
		// Exactly one record exists on disk.
		const entries = await readdir(taskDir);
		expect(entries.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
		await waitForState(service, started.record.jobId, "exited");
	});

	it("does not spawn after the service is closed while approval is pending", async () => {
		const gate: { resolve: (value: { approved: boolean; reason?: string }) => void } = {
			resolve: () => undefined,
		};
		const service = createService({
			approve: () =>
				new Promise<{ approved: boolean; reason?: string }>((resolve) => {
					gate.resolve = resolve;
				}),
		});
		const starting = service.start({
			toolCallId: "call-closed-1",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},5000)"',
		});
		// Stop/clear/abort lands while the start is still awaiting approval.
		await service.cancelAllJobs();
		gate.resolve({ approved: true });
		const result = await starting;
		expect(result.kind).toBe("invalid");
		expect(service.getLiveJob()).toBeNull();
	});

	it("does not spawn a start queued on the chain after the service is closed", async () => {
		// Hold the first start's approval so the second start queues behind it
		// on the start chain (not behind a live job).
		const gate: { resolve: (value: { approved: boolean; reason?: string }) => void } = {
			resolve: () => undefined,
		};
		const service = createService({
			approve: () =>
				new Promise<{ approved: boolean; reason?: string }>((resolve) => {
					gate.resolve = resolve;
				}),
		});
		const firstStart = service.start({
			toolCallId: "call-queue-1",
			command: process.execPath,
			args: '-e "setTimeout(()=>{},5000)"',
		});
		const secondStart = service.start({ toolCallId: "call-queue-2", command: process.execPath, args: "-e 1" });
		// Close with no live job: queued starts must not spawn afterwards.
		await service.cancelAllJobs();
		gate.resolve({ approved: true });
		const [first, second] = await Promise.all([firstStart, secondStart]);
		expect(first.kind).toBe("invalid");
		expect(second.kind).toBe("invalid");
		expect(service.getLiveJob()).toBeNull();
	});

	it("rejects NUL bytes in command or args before creating any state", async () => {
		const service = createService();
		expect((await service.start({ toolCallId: "call-nul-1", command: "node\u0000", args: "-e 1" })).kind).toBe(
			"invalid",
		);
		expect((await service.start({ toolCallId: "call-nul-2", command: "node", args: '-e "a\u0000b"' })).kind).toBe(
			"invalid",
		);
		const entries = await readdir(taskDir).catch(() => []);
		expect(entries).toEqual([]);
	});

	it("cancel kills group members still alive after the leader has exited", async () => {
		// The leader exits immediately but leaves a background member holding
		// the stdout pipe; cancel must still kill the whole process group, not
		// just settle the record around the live grandchildren.
		const pidFile = join(worktreeDir, `ar3-leak-pid-${process.pid}-${Date.now()}`);
		const service = createService();
		const started = await service.start({
			toolCallId: "call-leak",
			command: "sh",
			args: `-c "sleep 30 & echo $! > ${pidFile}; exit 0"`,
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		// Let the leader exit while the background sleeper keeps the pipes open.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const canceled = await service.cancelJob(started.record.jobId);
		expect(canceled?.state).toBe("canceled");
		const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
		expect(pid).toBeGreaterThan(0);
		// Poll briefly so the subreaper can reap the killed process before
		// the liveness probe (a zombie still answers kill(pid, 0)).
		let alive = true;
		for (let i = 0; i < 40 && alive; i += 1) {
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
			}
			if (alive) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		expect(alive).toBe(false);
		await rm(pidFile, { force: true }).catch(() => undefined);
	});

	it("discloses truncation when the spool is exactly full and output continues", async () => {
		const service = createService({ maxLogBytes: 16 });
		const started = await service.start({
			toolCallId: "call-trunc-exact",
			command: process.execPath,
			// First chunk fills the 16-byte spool exactly; the second is dropped
			// entirely by the remaining <= 0 branch.
			args: "-e \"process.stdout.write('aaaaaaaaaaaaaaaa');process.stdout.write('b')\"",
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		const settled = await waitForState(service, started.record.jobId, "exited");
		expect(settled.logBytesRetained).toBe(16);
		expect(settled.logBytesOmitted).toBeGreaterThan(0);
		expect(settled.logTruncated).toBe(true);
		// The settled log must carry the truncation marker, not claim completeness.
		const page = await service.readJobLog(started.record.jobId);
		expect(page?.text).toContain("validation job log incomplete");
	});

	it("does not reclassify a record that settled between the adoption scan and write", async () => {
		// The ended-session handler fires cancelAllJobs without awaiting; a
		// replacement service's adoption must not clobber the final status (and
		// artifactPath) that settle writes between the scan and the pre-write
		// re-read.
		const jobId = "f47ac10d-58cc-4372-a567-0e02b2c3d479";
		const record: ValidationJobRecord = {
			schemaVersion: VALIDATION_JOB_SCHEMA_VERSION,
			taskId: "task-ar3",
			sessionId: "session-ar3",
			jobId,
			toolCallId: "call-adopt-race",
			command: "node",
			args: ["-e", "1"],
			cwd: "",
			startedAt: new Date().toISOString(),
			endedAt: null,
			state: "running",
			exitCode: null,
			signal: null,
			timedOut: false,
			canceled: false,
			logTruncated: false,
			logBytesRetained: 0,
			logBytesOmitted: 0,
			artifactPath: null,
		};
		await mkdir(taskDir, { recursive: true });
		await writeFile(join(taskDir, `${jobId}.json`), JSON.stringify(record));
		const service = createService();
		const target = service as unknown as {
			readRecord: (id: string) => Promise<ValidationJobRecord | null>;
			writeRecord: (rec: ValidationJobRecord) => Promise<void>;
		};
		const originalRead = target.readRecord.bind(target);
		let readCalls = 0;
		target.readRecord = (id: string) => {
			readCalls += 1;
			if (readCalls === 1) {
				return originalRead(id); // The scan sees the record still running.
			}
			// A competing settle lands between the scan and the pre-write re-read.
			return Promise.resolve({
				...record,
				endedAt: new Date().toISOString(),
				state: "canceled",
				canceled: true,
				artifactPath: join(homeDir, "artifact.txt"),
			});
		};
		const writes: ValidationJobRecord[] = [];
		const originalWrite = target.writeRecord.bind(target);
		target.writeRecord = (rec: ValidationJobRecord) => {
			writes.push(rec);
			return originalWrite(rec);
		};
		await service.initialize();
		expect(readCalls).toBeGreaterThanOrEqual(2);
		expect(writes).toEqual([]);
		const settled = await service.getJob(jobId);
		expect(settled?.state).toBe("canceled");
		expect(settled?.artifactPath).toBe(join(homeDir, "artifact.txt"));
	});

	it("never returns an empty complete page while settlement is in flight", async () => {
		// While the archive is held, the settle window spans ~150ms: a reader
		// must always see the spool (job running) or the archive (job settled),
		// never neither.
		const service = new ValidationJobService({
			taskId: "task-ar3",
			sessionId: "session-ar3",
			worktreePath: worktreeDir,
			approve: async () => ({ approved: true }),
			archiveArtifact: async ({ content, toolCallId }) => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				const dir = getTaskContextArtifactsDir("task-ar3");
				await mkdir(dir, { recursive: true });
				const path = join(dir, `${toolCallId}.txt`);
				await writeFile(path, content);
				return path;
			},
		});
		const started = await service.start({
			toolCallId: "call-settle-read",
			command: process.execPath,
			args: "-e \"process.stdout.write('hello-log')\"",
		});
		if (started.kind !== "started") {
			throw new Error("expected started");
		}
		let settledSeen = false;
		let emptyPageSeen = false;
		for (let i = 0; i < 40 && !settledSeen; i += 1) {
			const record = await service.getJob(started.record.jobId);
			const page = await service.readJobLog(started.record.jobId);
			if (record !== null && record.state !== "running") {
				settledSeen = true;
			}
			if (page !== null && page.totalRetainedBytes > 0 && page.text.trim() === "") {
				emptyPageSeen = true;
			}
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
		expect(settledSeen).toBe(true);
		expect(emptyPageSeen).toBe(false);
		// And the settled page is still readable from the archive.
		const page = await service.readJobLog(started.record.jobId);
		expect(page?.text).toContain("hello-log");
	});
});
