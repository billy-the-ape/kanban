// B-6.6 — unit tests for the bounded review-session tool policy.
//
// The policy is a guardrail, not a sandbox: read tools and unclassified
// commands are approved (the default Kanban approval behavior), while Git
// publication / destructive worktree commands and writes outside the reviewed
// change set are denied with an actionable reason.
import { describe, expect, it } from "vitest";
import { createReviewToolPolicy } from "../../src/cline-sdk/review-tool-policy";
import type { ClineSdkToolApprovalRequest } from "../../src/cline-sdk/sdk-runtime-boundary";

const WORKTREE = "/tmp/review-worktree";
const ALLOWED_WRITE_PATHS = ["src/a.ts", "docs/plan.md"];

/** Builds a minimally-valid SDK tool approval request for a given tool + input. */
function makeRequest(toolName: string, input: unknown): ClineSdkToolApprovalRequest {
	return {
		sessionId: "review-session",
		agentId: "agent-1",
		conversationId: "conversation-1",
		iteration: 1,
		toolCallId: `toolcall-${toolName}`,
		toolName,
		input,
		policy: {},
	};
}

function createPolicy(overrides: { worktreePath?: string; allowedWritePaths?: readonly string[] } = {}) {
	return createReviewToolPolicy({
		worktreePath: overrides.worktreePath ?? WORKTREE,
		allowedWritePaths: overrides.allowedWritePaths ?? ALLOWED_WRITE_PATHS,
	});
}

describe("createReviewToolPolicy — reads and unknown tools are always approved", () => {
	it("approves every read-family tool and submit (no path scoping)", async () => {
		const policy = createPolicy();
		for (const toolName of [
			"read_files",
			"list_files",
			"search_codebase",
			"search_files",
			"fetch_web_content",
			"submit",
		]) {
			const result = await policy(makeRequest(toolName, { path: "/etc/hostname" }));
			expect(result.approved, toolName).toBe(true);
		}
	});

	it("approves unclassified (SDK-specific) tools by default", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("some_future_tool", { whatever: true }));
		expect(result.approved).toBe(true);
	});
});

describe("createReviewToolPolicy — command tool gating", () => {
	it("approves read-only Git and shell commands", async () => {
		const policy = createPolicy();
		for (const command of ["git status", "git diff", "git log --oneline", "git show HEAD", "npm test", "ls -la"]) {
			const result = await policy(makeRequest("run_commands", { commands: [command] }));
			expect(result.approved, command).toBe(true);
		}
	});

	it("denies git push (publication)", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("run_commands", { commands: ["git push origin main"] }));
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/git push/);
	});

	it("denies git commit (Kanban owns delivery)", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("run_commands", { commands: ["git commit -m 'wip'"] }));
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/git commit/);
	});

	it("denies git reset --hard / --merge (discarding work)", async () => {
		const policy = createPolicy();
		for (const command of ["git reset --hard HEAD~1", "git reset --merge HEAD"]) {
			const result = await policy(makeRequest("run_commands", { commands: [command] }));
			expect(result.approved, command).toBe(false);
			expect(result.reason).toMatch(/git reset --hard/);
		}
		// A soft/mixed reset (keeps work) is not flagged.
		const soft = await policy(makeRequest("run_commands", { commands: ["git reset HEAD~1"] }));
		expect(soft.approved).toBe(true);
	});

	it("denies forced git clean but allows a plain (no-force) clean", async () => {
		const policy = createPolicy();
		const forced = await policy(makeRequest("run_commands", { commands: ["git clean -fd"] }));
		expect(forced.approved).toBe(false);
		expect(forced.reason).toMatch(/forced git clean/);
		const plain = await policy(makeRequest("run_commands", { commands: ["git clean -n"] }));
		expect(plain.approved).toBe(true);
	});

	it("denies removing the .git directory (rm -rf .git)", async () => {
		const policy = createPolicy();
		for (const command of ["rm -rf .git", "rm -rf ./worktree/.git"]) {
			const result = await policy(makeRequest("run_commands", { commands: [command] }));
			expect(result.approved, command).toBe(false);
			expect(result.reason).toMatch(/removing the \.git directory/);
		}
		// A plain recursive force removal of a non-git path is not flagged.
		const notGit = await policy(makeRequest("run_commands", { commands: ["rm -rf build"] }));
		expect(notGit.approved).toBe(true);
	});

	it("scans every shell fragment (push hidden behind && is still denied)", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("run_commands", { commands: ["echo done && git push origin"] }));
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/git push/);
	});

	it("handles the single-command and structured command inputs", async () => {
		const policy = createPolicy();
		// { command } object.
		const object = await policy(makeRequest("run_commands", { command: "git push origin" }));
		expect(object.approved).toBe(false);
		// Structured { command, args } entries.
		const structured = await policy(
			makeRequest("run_commands", { commands: [{ command: "git", args: ["push", "origin"] }] }),
		);
		expect(structured.approved).toBe(false);
		// A harmless structured command is approved.
		const okStructured = await policy(
			makeRequest("run_commands", { commands: [{ command: "git", args: ["status"] }] }),
		);
		expect(okStructured.approved).toBe(true);
	});
});

describe("createReviewToolPolicy — scoped writes", () => {
	it("approves edits to files in the reviewed change set", async () => {
		const policy = createPolicy();
		for (const toolName of ["editor", "write_to_file", "replace_in_file"]) {
			for (const path of ALLOWED_WRITE_PATHS) {
				const result = await policy(makeRequest(toolName, { path }));
				expect(result.approved, `${toolName} ${path}`).toBe(true);
			}
		}
	});

	it("denies edits to files outside the reviewed change set", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("editor", { path: "src/other.ts" }));
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/may only modify reviewed files/);
	});

	it("denies edits to absolute paths outside the worktree", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("editor", { path: "/tmp/somewhere-else/file.ts" }));
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/may only modify reviewed files/);
	});

	it("scopes relative paths against the worktree (in-worktree but not allowed is denied)", async () => {
		const policy = createPolicy();
		// "src/a.ts" resolves to <worktree>/src/a.ts (allowed); "a.ts" resolves to
		// <worktree>/a.ts (not in the change set) and must be denied.
		const allowed = await policy(makeRequest("editor", { path: "src/a.ts" }));
		expect(allowed.approved).toBe(true);
		const notAllowed = await policy(makeRequest("editor", { path: "a.ts" }));
		expect(notAllowed.approved).toBe(false);
	});
});

describe("createReviewToolPolicy — apply_patch scoping", () => {
	// The policy reads the patch from a record input ({ input: "..." }); the
	// block-form patch headers ("*** Add/Update/Delete File: <path>") are the
	// only thing scanned, so the patch body below is a minimal one.
	const patchFor = (path: string) => `*** Update File: ${path}\n@@ -1 +1 @@\n-old\n+new`;
	const patchInput = (path: string) => ({ input: patchFor(path) });

	it("approves a patch whose targets are all in the reviewed change set", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("apply_patch", patchInput("src/a.ts")));
		expect(result.approved).toBe(true);
	});

	it("approves a multi-file patch when every target is in the reviewed change set", async () => {
		const policy = createPolicy();
		const result = await policy(
			makeRequest("apply_patch", { input: `*** Update File: src/a.ts\n*** Add File: docs/plan.md` }),
		);
		expect(result.approved).toBe(true);
	});

	it("denies a patch that touches a file outside the reviewed change set", async () => {
		const policy = createPolicy();
		const result = await policy(
			makeRequest("apply_patch", { input: `*** Update File: src/a.ts\n*** Update File: src/other.ts` }),
		);
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/may only modify reviewed files/);
	});

	it("denies an unparseable patch (no recognizable file headers)", async () => {
		const policy = createPolicy();
		const result = await policy(makeRequest("apply_patch", { input: "not a patch at all" }));
		expect(result.approved).toBe(false);
		expect(result.reason).toMatch(/unparseable patch/);
	});
});

describe("createReviewToolPolicy — history, cleanup, and publication commands", () => {
	it("denies commands that move history, discard work, or publish", async () => {
		const policy = createPolicy();
		for (const command of [
			"git merge feature",
			"git rebase main",
			"git cherry-pick abc123",
			"git pull",
			"git update-ref refs/heads/main HEAD",
			"git tag v1",
			"git stash",
			"git stash push -m wip",
			"git checkout -- .",
			"git checkout main",
			"git switch main",
			"git restore src/a.ts",
			"git worktree remove ../other",
			"git worktree prune",
			"git branch -D feature",
			"gh pr create --fill",
			"gh pr merge 3",
			"rm -rf .",
			"rm -rf ./",
			"rm --recursive --force *",
		]) {
			const result = await policy(makeRequest("run_commands", { commands: [command] }));
			expect(result.approved, command).toBe(false);
		}
	});

	it("still allows read-only and index-only variants", async () => {
		const policy = createPolicy();
		for (const command of [
			"git stash list",
			"git restore --staged src/a.ts",
			"git branch --list",
			"git worktree list",
			"gh pr view 3",
			"rm -rf build",
		]) {
			const result = await policy(makeRequest("run_commands", { commands: [command] }));
			expect(result.approved, command).toBe(true);
		}
	});
});

describe("createReviewToolPolicy — workspace approval delegation", () => {
	it("defers every non-denied request to the workspace approval handler", async () => {
		const delegated: string[] = [];
		const policy = createReviewToolPolicy({
			worktreePath: WORKTREE,
			allowedWritePaths: ALLOWED_WRITE_PATHS,
			delegate: async (request) => {
				delegated.push(request.toolName);
				return { approved: false, reason: "workspace policy says no" };
			},
		});

		const read = await policy(makeRequest("read_files", { path: "src/a.ts" }));
		expect(read).toEqual({ approved: false, reason: "workspace policy says no" });
		const edit = await policy(makeRequest("editor", { path: "src/a.ts" }));
		expect(edit.reason).toBe("workspace policy says no");
		// A review denial never reaches the workspace handler.
		const push = await policy(makeRequest("run_commands", { commands: ["git push"] }));
		expect(push.reason).toMatch(/git push/);
		expect(delegated).toEqual(["read_files", "editor"]);
	});
});
