import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { githubPrTrackingRecordSchema } from "../../../src/core/api-contract";
import { prKeyDigest } from "../../../src/pr-tracking/pr-identity";
import { PR_ORPHAN_RETENTION_MS, type PrRecordIdentity, PrRecordStore } from "../../../src/pr-tracking/pr-record-store";

const KEY = "github|github.com|cline/kanban|49";
const IDENTITY: PrRecordIdentity = {
	canonicalPrKey: KEY,
	provider: "github",
	host: "github.com",
	repository: "cline/kanban",
	number: 49,
};

let root: string;
let store: PrRecordStore;
let nowValue: number;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kanban-pr-store-"));
	nowValue = 1_700_000_000_000;
	store = new PrRecordStore({ rootPath: root, now: () => nowValue });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("pr-record-store", () => {
	it("creates version-1 records at the sha256 key path", async () => {
		const result = await store.createRecord(IDENTITY);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.record.schemaVersion).toBe(1);
		expect(result.record.revision).toBe(0);
		expect(existsSync(join(root, "prs", `${prKeyDigest(KEY)}.json`))).toBe(true);
	});

	it("is idempotent for existing records and refuses to clobber malformed ones", async () => {
		await store.createRecord(IDENTITY);
		const again = await store.createRecord(IDENTITY);
		expect(again.ok).toBe(true);

		const otherKey = "github|github.com|cline/other|7";
		writeFileSync(join(root, "prs", `${prKeyDigest(otherKey)}.json`), "not json{", "utf8");
		const clobber = await store.createRecord({
			canonicalPrKey: otherKey,
			provider: "github",
			host: "github.com",
			repository: "cline",
			number: 7,
		});
		expect(clobber).toEqual({ ok: false, reason: "malformed" });
	});

	it("loads records validating composite identity against the key", async () => {
		expect(await store.loadRecord("github|github.com|cline/kanban|999")).toEqual({ ok: false, reason: "not_found" });
		expect(await store.loadRecord("not-a-key")).toEqual({ ok: false, reason: "malformed" });

		await store.createRecord(IDENTITY);
		expect((await store.loadRecord(KEY)).ok).toBe(true);

		// Corrupt the identity: number no longer matches the key.
		const loaded = await store.loadRecord(KEY);
		if (!loaded.ok) {
			return;
		}
		writeFileSync(
			join(root, "prs", `${prKeyDigest(KEY)}.json`),
			JSON.stringify({ ...loaded.record, number: 50 }),
			"utf8",
		);
		expect(await store.loadRecord(KEY)).toEqual({ ok: false, reason: "malformed" });
	});

	it("checks revision and preserves unrelated fields on update", async () => {
		await store.createRecord(IDENTITY);
		const seeded = await store.updateRecord(KEY, 0, (record) => ({
			...record,
			commentAutomation: { ...record.commentAutomation, debounceDeadline: 123 },
		}));
		expect(seeded.ok).toBe(true);
		if (!seeded.ok) {
			return;
		}
		expect(seeded.record.revision).toBe(1);
		expect(seeded.record.commentAutomation.debounceDeadline).toBe(123);

		expect(await store.updateRecord(KEY, 0, (record) => record)).toEqual({ ok: false, reason: "conflict" });

		const again = await store.updateRecord(KEY, 1, (record) => ({
			...record,
			orphanedAt: null,
		}));
		expect(again.ok).toBe(true);
		if (!again.ok) {
			return;
		}
		expect(again.record.commentAutomation.debounceDeadline).toBe(123);
		expect(again.record.revision).toBe(2);
	});
	it("enumerates records and reports malformed files", async () => {
		await store.createRecord(IDENTITY);
		writeFileSync(join(root, "prs", `${prKeyDigest("github|github.com|cline/x|1")}.json`), "{broken", "utf8");
		const { records, malformedFiles } = await store.listRecords();
		expect(records.map((record) => record.canonicalPrKey)).toEqual([KEY]);
		expect(malformedFiles).toHaveLength(1);
	});

	it("upserts task bindings with monotonic link generations and preserves consumed markers", async () => {
		await store.createRecord(IDENTITY);
		const bindingId = { workspaceId: "ws-1", taskId: "task-1" };
		const created = await store.upsertTaskBinding(KEY, bindingId);
		expect(created.ok).toBe(true);
		if (!created.ok) {
			return;
		}
		expect(created.record.taskBindings).toHaveLength(1);
		expect(created.record.taskBindings[0]?.linkGeneration).toBe(1);

		// Consume a merge completion, then re-link the same handled PR.
		const consumed = await store.updateTaskBinding(KEY, bindingId, undefined, (item) => ({
			...item,
			mergeCompletion: {
				schemaVersion: 1,
				workspaceId: "ws-1",
				taskId: "task-1",
				linkGeneration: item.linkGeneration,
				prKey: KEY,
				finalHeadSha: "abc123",
				baseRepository: "cline/kanban",
				baseRef: "main",
				mergeCommitSha: "m1",
				mergedAt: 123,
				observedAt: 123,
				status: "completed",
				completedAt: 123,
				error: null,
			},
		}));
		expect(consumed.ok).toBe(true);

		const relinked = await store.upsertTaskBinding(KEY, bindingId);
		expect(relinked.ok).toBe(true);
		if (!relinked.ok) {
			return;
		}
		expect(relinked.record.taskBindings).toHaveLength(1);
		expect(relinked.record.taskBindings[0]?.linkGeneration).toBe(2);
		expect(relinked.record.taskBindings[0]?.mergeCompletion?.status).toBe("completed");
	});

	it("sets and clears terminal stop markers", async () => {
		await store.createRecord(IDENTITY);
		const bindingId = { workspaceId: "ws-1", taskId: "task-1" };
		await store.upsertTaskBinding(KEY, bindingId);
		const stopped = await store.setTaskTerminalStop(KEY, bindingId, {
			reason: "closed_unmerged",
			observedAt: nowValue,
			reconciliationReads: 0,
		});
		expect(stopped.ok).toBe(true);
		if (!stopped.ok) {
			return;
		}
		expect(stopped.record.taskBindings[0]?.terminalStop?.reason).toBe("closed_unmerged");

		const cleared = await store.setTaskTerminalStop(KEY, bindingId, null);
		expect(cleared.ok).toBe(true);
		if (!cleared.ok) {
			return;
		}
		expect(cleared.record.taskBindings[0]?.terminalStop).toBeNull();
	});

	it("stores scoped metadata snapshots keyed by access scope", async () => {
		await store.createRecord(IDENTITY);
		const base = await store.loadRecord(KEY);
		expect(base.ok).toBe(true);
		if (!base.ok) {
			return;
		}
		expect(base.record.snapshots["scope-a"]).toBeUndefined();

		await store.setMetadataSnapshot(KEY, {
			accessScopeId: "scope-a",
			checkedAt: 1,
			state: "open",
			headRepository: "cline/kanban",
			headRef: "feature",
			baseRepository: "cline/kanban",
			baseRef: "main",
			headSha: "abc123",
			mergedAt: null,
			mergeCommitSha: null,
		});
		await store.setMetadataSnapshot(KEY, {
			accessScopeId: "scope-b",
			checkedAt: 2,
			state: "open",
			headRepository: "cline/kanban",
			headRef: "feature",
			baseRepository: "cline/kanban",
			baseRef: "main",
			headSha: "def456",
			mergedAt: null,
			mergeCommitSha: null,
		});
		const both = await store.loadRecord(KEY);
		expect(both.ok).toBe(true);
		if (!both.ok) {
			return;
		}
		expect(both.record.snapshots["scope-a"]?.headSha).toBe("abc123");
		expect(both.record.snapshots["scope-b"]?.headSha).toBe("def456");
	});

	it("deletes orphan records only after retention with no live operation", async () => {
		await store.createRecord(IDENTITY);
		// Never orphaned.
		expect(await store.deleteOrphanRecord(KEY, {})).toEqual({ ok: false, reason: "not_orphaned" });

		// Orphaned but retention not elapsed.
		await store.updateRecord(KEY, undefined, (record) => ({ ...record, orphanedAt: nowValue - 1000 }));
		expect(await store.deleteOrphanRecord(KEY, {})).toEqual({ ok: false, reason: "not_orphaned" });

		// A linked task clears the orphan clock; orphan it again past retention
		// with the binding still live.
		await store.upsertTaskBinding(KEY, { workspaceId: "ws-1", taskId: "task-1" });
		expect(
			(await store.updateRecord(KEY, undefined, (record) => ({ ...record, orphanedAt: nowValue - 1000 }))).ok,
		).toBe(true);
		nowValue += PR_ORPHAN_RETENTION_MS + 1;
		expect(await store.deleteOrphanRecord(KEY, {})).toEqual({ ok: false, reason: "has_live_operation" });

		// Clear the binding; still within a fresh retention window.
		const cleared = await store.updateRecord(KEY, undefined, (record) => ({
			...record,
			taskBindings: [],
			orphanedAt: nowValue - 1000,
		}));
		expect(cleared.ok).toBe(true);
		expect(await store.deleteOrphanRecord(KEY, {})).toEqual({ ok: false, reason: "not_orphaned" });

		// Beyond retention with nothing outstanding: deleted.
		nowValue += PR_ORPHAN_RETENTION_MS + 1;
		expect(await store.deleteOrphanRecord(KEY, {})).toEqual({ ok: true });
		expect(await store.loadRecord(KEY)).toEqual({ ok: false, reason: "not_found" });
	});

	it("honors explicit retention windows and keeps the record schema version-1", async () => {
		await store.createRecord(IDENTITY);
		await store.updateRecord(KEY, undefined, (record) => ({ ...record, orphanedAt: 1 }));
		expect(await store.deleteOrphanRecord(KEY, { retentionMs: 10 })).toEqual({ ok: true });

		const record = githubPrTrackingRecordSchema.parse({
			schemaVersion: 1,
			revision: 0,
			updatedAt: 0,
			canonicalPrKey: KEY,
			provider: "github",
			host: "github.com",
			repository: "cline/kanban",
			number: 49,
			orphanedAt: null,
			snapshots: {},
			taskBindings: [],
			commentAutomation: {
				repairOwner: null,
				pendingFeedbackFingerprint: null,
				lastDispatchedFeedbackFingerprint: null,
				debounceDeadline: null,
				firstPendingAt: null,
				dispatch: null,
			},
			reservation: {
				ownerRevision: 0,
				fencingGeneration: 0,
				state: "none",
				reservedBy: null,
				reservedOperation: null,
				transferHandoff: null,
			},
		});
		expect(record.schemaVersion).toBe(1);
	});
});
