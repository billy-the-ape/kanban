// AM-1: per-repository auto-merge policy store — revision-checked CAS
// updates, fail-closed reads (missing/malformed -> no policy), and exact
// check-name validation.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AutoMergePolicyStore,
	type AutoMergePolicyStoreOptions,
	normalizeAutoMergeRepository,
	validateRequiredChecks,
} from "../../../src/pr-tracking/auto-merge-policy-store";

let root: string | undefined;

beforeEach(async () => {
	const dir = await mkTempDir();
	root = dir;
});

afterEach(async () => {
	if (root) {
		await rm(root, { recursive: true, force: true });
	}
	root = undefined;
});

async function mkTempDir(): Promise<string> {
	return await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "am1-policy-store-"));
}

function createStore(
	rootPath: string,
	options: Omit<AutoMergePolicyStoreOptions, "rootPath"> = {},
): AutoMergePolicyStore {
	return new AutoMergePolicyStore({ rootPath, now: () => 1_700_000_000_000, ...options });
}

function getRoot(): string {
	if (root === undefined) {
		throw new Error("temp root not initialized");
	}
	return root;
}

describe("normalizeAutoMergeRepository", () => {
	it("normalizes to a lowercase owner/repo key", () => {
		expect(normalizeAutoMergeRepository("Cline/Kanban ")).toBe("cline/kanban");
		expect(normalizeAutoMergeRepository("OWNER_1/repo.v2")).toBe("owner_1/repo.v2");
	});

	it("rejects hosts, groups, globs, and empty segments", () => {
		expect(normalizeAutoMergeRepository("github.com/cline/kanban")).toBeNull();
		expect(normalizeAutoMergeRepository("cline")).toBeNull();
		expect(normalizeAutoMergeRepository("org/*")).toBeNull();
		expect(normalizeAutoMergeRepository("org?/repo")).toBeNull();
		expect(normalizeAutoMergeRepository("/kanban")).toBeNull();
		expect(normalizeAutoMergeRepository("org/")).toBeNull();
		expect(normalizeAutoMergeRepository("")).toBeNull();
	});
});

describe("validateRequiredChecks", () => {
	it("trims and rejects empty, whitespace, glob, and empty lists", () => {
		expect(validateRequiredChecks([" Build ", "lint"])).toEqual(["Build", "lint"]);
		expect(validateRequiredChecks(["Build", "build"])).toEqual(["Build", "build"]);
		expect(validateRequiredChecks([])).toBeNull();
		expect(validateRequiredChecks([""])).toBeNull();
		expect(validateRequiredChecks(["   "])).toBeNull();
		expect(validateRequiredChecks(["ci *"])).toBeNull();
		expect(validateRequiredChecks(["a?"])).toBeNull();
		expect(validateRequiredChecks(["a b"])).toBeNull();
	});
});

describe("AutoMergePolicyStore", () => {
	it("reads no policy for a missing store or missing entry", async () => {
		const store = createStore(getRoot());
		expect(await store.loadPolicy("cline/kanban")).toBeNull();
		expect(await store.loadPolicy("https://github.com/cline/kanban")).toBeNull();
	});

	it("creates and replaces policies per repository with monotonically increasing revisions", async () => {
		const store = createStore(getRoot());
		const first = await store.updatePolicy("Cline/Kanban", { requiredChecks: ["Build"], mergeMethod: "squash" }, 0);
		expect(first.ok).toBe(true);
		if (!first.ok) {
			throw new Error("first update failed");
		}
		expect(first.policy).toMatchObject({
			repository: "cline/kanban",
			requiredChecks: ["Build"],
			mergeMethod: "squash",
			revision: 1,
			updatedAt: 1_700_000_000_000,
		});
		// A second repository is independent.
		const other = await store.updatePolicy("other/repo", { requiredChecks: ["ci"] }, undefined);
		expect(other.ok).toBe(true);
		const both = await store.loadPolicy("cline/kanban");
		if (both === null) {
			throw new Error("policy missing after write");
		}
		expect(both.revision).toBe(1);
		const replacement = await store.updatePolicy("cline/kanban", { requiredChecks: ["Build", "Lint"] }, 1);
		expect(replacement.ok).toBe(true);
		if (!replacement.ok) {
			throw new Error("replacement failed");
		}
		expect(replacement.policy.revision).toBe(2);
		expect(replacement.policy.requiredChecks).toEqual(["Build", "Lint"]);
		// The other repository is untouched by the replacement.
		const otherPolicy = await store.loadPolicy("other/repo");
		expect(otherPolicy?.requiredChecks).toEqual(["ci"]);
		expect(otherPolicy?.mergeMethod).toBe("merge");
	});

	it("treats a missing policy as revision 0 and rejects stale revisions", async () => {
		const store = createStore(getRoot());
		const created = await store.updatePolicy("org/repo", { requiredChecks: ["ci"] }, 0);
		expect(created.ok).toBe(true);
		const stale = await store.updatePolicy("org/repo", { requiredChecks: ["ci", "docs"] }, 0);
		expect(stale).toEqual({ ok: false, reason: "conflict" });
		const fresh = await store.loadPolicy("org/repo");
		expect(fresh?.requiredChecks).toEqual(["ci"]);
		expect(fresh?.revision).toBe(1);
		const correct = await store.updatePolicy("org/repo", { requiredChecks: ["ci", "docs"] }, 1);
		expect(correct.ok).toBe(true);
	});

	it("rejects invalid repositories and check lists without writing", async () => {
		const store = createStore(getRoot());
		expect(await store.updatePolicy("github.com/cline/kanban", { requiredChecks: ["ci"] }, 0)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(await store.updatePolicy("org/repo", { requiredChecks: [] }, 0)).toEqual({ ok: false, reason: "invalid" });
		expect(await store.updatePolicy("org/repo", { requiredChecks: ["ci *"] }, 0)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(await store.loadPolicy("org/repo")).toBeNull();
	});

	it("reads a malformed store as no policy and refuses to overwrite it", async () => {
		const store = createStore(getRoot());
		await mkdir(join(getRoot(), "auto-merge"), { recursive: true });
		await writeFile(store.policiesPath, "{ not json", "utf8");
		expect(await store.loadPolicy("org/repo")).toBeNull();
		expect(await store.updatePolicy("org/repo", { requiredChecks: ["ci"] }, 0)).toEqual({
			ok: false,
			reason: "malformed",
		});
		const raw = await readFile(store.policiesPath, "utf8");
		expect(raw).toBe("{ not json");
	});

	it("reads a wrong-version store as malformed (fail closed, no migration)", async () => {
		const store = createStore(getRoot());
		await mkdir(join(getRoot(), "auto-merge"), { recursive: true });
		await writeFile(
			store.policiesPath,
			JSON.stringify({ version: 2, policies: { "org/repo": { revision: 5 } } }),
			"utf8",
		);
		expect(await store.loadPolicy("org/repo")).toBeNull();
		expect(await store.updatePolicy("org/repo", { requiredChecks: ["ci"] }, 0)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});
