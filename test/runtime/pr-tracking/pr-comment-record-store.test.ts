import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeTaskPullRequest } from "../../../src/core/api-contract";
import {
	createInitialPrTrackingRecord,
	getPrTrackingRecordPath,
	listPrTrackingRecords,
	loadPrTrackingRecord,
	upsertPrTrackingRecord,
} from "../../../src/pr-tracking/pr-comment-record-store";
import {
	getPrTrackingRecordPath as getSharedRecordPath,
	PrRecordStore,
} from "../../../src/pr-tracking/pr-record-store";
import { isolateTestEnvironment } from "../../utilities/test-environment";

let env: ReturnType<typeof isolateTestEnvironment>;

beforeEach(() => {
	env = isolateTestEnvironment();
});

afterEach(() => {
	env.cleanup();
});

function makePr(): RuntimeTaskPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "octo/repo",
		number: 42,
		url: "https://github.com/octo/repo/pull/42",
		source: "manual",
		createdAt: 1_700_000_000_000,
	};
}

const CANONICAL_KEY = "github|github.com|octo/repo|42";

describe("pr record store", () => {
	it("stores one record per canonical PR key under the isolated runtime home", async () => {
		const path = getPrTrackingRecordPath(CANONICAL_KEY);
		expect(path.startsWith(env.home)).toBe(true);
		// A revision-unchanged update never writes a file.
		expect((await loadPrTrackingRecord(CANONICAL_KEY)).status).toBe("missing");
		const created = await upsertPrTrackingRecord(
			CANONICAL_KEY,
			{ accessScopeId: "scope-1", pr: makePr() },
			(record) => ({
				...record,
				revision: record.revision + 1,
				taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
			}),
		);
		expect(created.schemaVersion).toBe(1);
		expect(created.revision).toBe(1);
		expect(created.accessScopeId).toBe("scope-1");
		const loaded = await loadPrTrackingRecord(CANONICAL_KEY);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") {
			throw new Error("unreachable");
		}
		expect(loaded.record.pr.number).toBe(42);
		expect(loaded.record.commentAutomation.repairOwner).toBeNull();
	});

	it("advances the revision by exactly one on a change and skips unchanged writes", async () => {
		const identity = { accessScopeId: "scope-1", pr: makePr() };
		const bumped = await upsertPrTrackingRecord(CANONICAL_KEY, identity, (record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
		}));
		expect(bumped.revision).toBe(1);
		expect(bumped.taskBindings).toEqual([{ workspaceId: "w1", taskId: "t1", terminal: false }]);
		const unchanged = await upsertPrTrackingRecord(CANONICAL_KEY, identity, (record) => record);
		expect(unchanged.revision).toBe(1);
		await expect(
			upsertPrTrackingRecord(CANONICAL_KEY, identity, (record) => ({
				...record,
				revision: record.revision + 2,
				taskBindings: record.taskBindings,
			})),
		).rejects.toThrow("revision must advance by exactly one");
	});

	it("reports missing and malformed records without throwing", async () => {
		expect((await loadPrTrackingRecord("github|github.com|none/none|1")).status).toBe("missing");
		const path = getPrTrackingRecordPath("github|github.com|bad/repo|3");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "{ not json", "utf8");
		const malformed = await loadPrTrackingRecord("github|github.com|bad/repo|3");
		expect(malformed.status).toBe("malformed");
		// Malformed records block updates instead of crashing.
		await expect(
			upsertPrTrackingRecord(
				"github|github.com|bad/repo|3",
				{ accessScopeId: "s", pr: makePr() },
				(record) => record,
			),
		).rejects.toThrow("malformed");
	});

	it("rejects records whose identity does not match their storage key", async () => {
		const record = createInitialPrTrackingRecord({
			canonicalPrKey: "github|github.com|octo/repo|42",
			accessScopeId: "s",
			pr: makePr(),
		});
		const wrongKey = "github|github.com|octo/repo|43";
		const path = getPrTrackingRecordPath(wrongKey);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(record), "utf8");
		const loaded = await loadPrTrackingRecord(wrongKey);
		expect(loaded.status).toBe("malformed");
	});

	it("lists durable records and skips malformed files", async () => {
		const secondKey = "github|github.com|other/repo|7";
		await upsertPrTrackingRecord(CANONICAL_KEY, { accessScopeId: "scope-1", pr: makePr() }, (record) => ({
			...record,
			revision: record.revision + 1,
		}));
		await upsertPrTrackingRecord(
			secondKey,
			{ accessScopeId: "scope-1", pr: { ...makePr(), repository: "other/repo", number: 7 } },
			(record) => ({
				...record,
				revision: record.revision + 1,
			}),
		);
		const badDir = join(env.home, ".cline", "kanban", "pr-tracking", "comments");
		await writeFile(join(badDir, "not-a-record.json"), "garbage", "utf8");
		const records = await listPrTrackingRecords();
		expect(records.map((record) => record.canonicalPrKey).sort()).toEqual([CANONICAL_KEY, secondKey]);
	});
});

describe("comment and merge record coexistence", () => {
	it("keeps comment updates from overwriting merge-tracking state for the same PR", async () => {
		const shared = new PrRecordStore();
		await shared.createRecord({
			canonicalPrKey: CANONICAL_KEY,
			provider: "github",
			host: "github.com",
			repository: "octo/repo",
			number: 42,
		});
		await shared.upsertTaskBinding(CANONICAL_KEY, { workspaceId: "w1", taskId: "t1" });
		await shared.setTaskTerminalStop(
			CANONICAL_KEY,
			{ workspaceId: "w1", taskId: "t1" },
			{ reason: "merged_completed", observedAt: 100, reconciliationReads: 0 },
		);
		const before = await shared.loadRecord(CANONICAL_KEY);
		expect(before.ok && before.record.taskBindings[0]?.terminalStop?.reason).toBe("merged_completed");
		await upsertPrTrackingRecord(CANONICAL_KEY, { accessScopeId: "scope-1", pr: makePr() }, (record) => ({
			...record,
			revision: record.revision + 1,
			taskBindings: [{ workspaceId: "w1", taskId: "t1", terminal: false }],
		}));
		expect(getPrTrackingRecordPath(CANONICAL_KEY)).not.toBe(getSharedRecordPath(CANONICAL_KEY));
		expect(await shared.loadRecord(CANONICAL_KEY)).toEqual(before);
		expect((await loadPrTrackingRecord(CANONICAL_KEY)).status).toBe("ok");
		expect((await listPrTrackingRecords()).length).toBe(1);
		expect((await shared.listRecords()).records.length).toBe(1);
	});
});
