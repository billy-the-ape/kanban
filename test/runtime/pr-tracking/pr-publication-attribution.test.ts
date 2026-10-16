import { describe, expect, it } from "vitest";
import {
	analyzePrPublication,
	detectPublicationOperations,
	isEditOnlyPublicationActivity,
	type PrPublicationOperation,
	type PrPublicationTarget,
	resolvePublicationOutput,
} from "../../../src/pr-tracking/pr-publication-attribution";

const TARGET: PrPublicationTarget = { host: "github.com", repository: "octo/repo", number: 42 };

describe("detectPublicationOperations gh api value flags", () => {
	it("treats the -q jq filter value as a flag value, not the endpoint", () => {
		const fragment = "gh api -q .html_url -X POST repos/octo/repo/issues/5/comments -f body='addressing'";
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api",
				kind: "conversation",
				explicitRepository: "octo/repo",
				explicitNumber: 5,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it("treats the -p/--preview value as a flag value, not the endpoint", () => {
		const fragment = "gh api -p alpha repos/octo/repo/pulls/7/comments/11/replies -f body='inline'";
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api",
				kind: "inline",
				explicitRepository: "octo/repo",
				explicitNumber: 7,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it("keeps -q from mistaking the jq expression for an endpoint on reads", () => {
		// A jq-filtered read stays out of detection entirely.
		expect(detectPublicationOperations(["gh api -q .issue_url GET repos/octo/repo/issues/5/comments/9"])).toEqual([]);
	});
});

describe("detectPublicationOperations non-feedback writes", () => {
	it("ignores writes to endpoints that cannot create PR feedback", () => {
		expect(
			detectPublicationOperations([
				"gh api -X POST repos/octo/repo/pulls/42/labels -f label=bug",
				"gh api -X POST repos/octo/repo/pulls/42/requested_reviewers -f reviewers=octo",
				"gh api -X POST repos/octo/repo/pulls/42/review_requests",
			]),
		).toEqual([]);
	});

	it("ignores read-looking calls to those endpoints", () => {
		expect(detectPublicationOperations(["gh api -X GET repos/octo/repo/pulls/42/review_requests"])).toEqual([]);
	});
});

describe("detectPublicationOperations graphql", () => {
	it("ignores a graphql read that carries no comment-creating mutation", () => {
		const fragment =
			"gh api graphql -f query='query { pullRequest { reviewThreads(first: 20) { nodes { isResolved } } } }'";
		expect(detectPublicationOperations([fragment])).toEqual([]);
	});

	it("recognizes a comment-creating graphql mutation as an unattributable operation", () => {
		const fragment = "gh api graphql -f query='mutation { addComment(input: {body: \"addressing\"}) }'";
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api graphql",
				kind: null,
				explicitRepository: null,
				explicitNumber: null,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it("treats a graphql call whose query is not in the command text as unattributable", () => {
		const fragment = "gh api graphql --input mutation.json";
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api graphql",
				kind: null,
				explicitRepository: null,
				explicitNumber: null,
				fragment,
				bareIdOutput: false,
			},
		]);
	});
});

describe("analyzePrPublication graphql writes", () => {
	it("pauses with an uncertain capture for a comment-creating graphql mutation", () => {
		const observation = analyzePrPublication({
			toolName: "run_command",
			commands: ["gh api graphql -f query='mutation { addComment(input: {body: \"addressing\"}) }'"],
			output: null,
			error: null,
			linkedPullRequests: [TARGET],
		});
		expect(observation.status).toBe("uncertain");
		expect(observation.target).toEqual(TARGET);
		expect(observation.reason).toContain("cannot be attributed");
	});

	it("stays uncertain even when the mutation returns output", () => {
		const observation = analyzePrPublication({
			toolName: "run_command",
			commands: ["gh api graphql -f query='mutation { addPullRequestReviewComment(input: {body: \"inline\"}) }'"],
			output: JSON.stringify({ data: { addPullRequestReviewComment: { comment: { databaseId: 512 } } } }),
			error: null,
			linkedPullRequests: [TARGET],
		});
		expect(observation.status).toBe("uncertain");
		expect(observation.identities).toEqual([]);
	});
});

describe("readPrSelection positional number strictness", () => {
	it("reads a number directly after the action", () => {
		expect(detectPublicationOperations(["gh pr comment 42 -b 'x'"])).toEqual([
			{
				operation: "gh pr comment",
				kind: "conversation",
				explicitRepository: null,
				explicitNumber: 42,
				fragment: "gh pr comment 42 -b 'x'",
				bareIdOutput: false,
			},
		]);
	});

	it("reads a number as the sole positional after value flags", () => {
		expect(detectPublicationOperations(["gh pr comment -b 'x' 42"])).toEqual([
			{
				operation: "gh pr comment",
				kind: "conversation",
				explicitRepository: null,
				explicitNumber: 42,
				fragment: "gh pr comment -b 'x' 42",
				bareIdOutput: false,
			},
		]);
	});

	it("does not read a stray number that is one of several positionals", () => {
		expect(detectPublicationOperations(["gh pr comment -b 'x' 12 34"])).toEqual([
			{
				operation: "gh pr comment",
				kind: "conversation",
				explicitRepository: null,
				explicitNumber: null,
				fragment: "gh pr comment -b 'x' 12 34",
				bareIdOutput: false,
			},
		]);
	});

	it("reads a -R repository plus a number", () => {
		expect(detectPublicationOperations(["gh pr comment -R octo/repo 43"])).toEqual([
			{
				operation: "gh pr comment",
				kind: "conversation",
				explicitRepository: "octo/repo",
				explicitNumber: 43,
				fragment: "gh pr comment -R octo/repo 43",
				bareIdOutput: false,
			},
		]);
	});

	it("does not read a number that escapes out of a quoted body", () => {
		// Escaped quotes inside the double-quoted body keep the whole body a
		// single token, so the embedded number is never a positional.
		const fragment = 'gh pr comment --body "Fixed \\"the parser 12 bug\\""';
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh pr comment",
				kind: "conversation",
				explicitRepository: null,
				explicitNumber: null,
				fragment,
				bareIdOutput: false,
			},
		]);
	});
});

describe("resolvePublicationOutput write-fragment scoping", () => {
	const writeOperation: PrPublicationOperation = {
		operation: "gh pr comment",
		kind: "conversation",
		explicitRepository: null,
		explicitNumber: null,
		fragment: "gh pr comment -b 'addressing'",
		bareIdOutput: false,
	};

	it("registers only the write fragment's identity from a structured multi-fragment result", () => {
		const output = JSON.stringify([
			{
				query: "gh pr comment -b 'addressing'",
				result: "https://github.com/octo/repo/pull/42#issuecomment-9",
				success: true,
			},
			{
				query: "gh pr view 42 --json comments",
				result: JSON.stringify([{ id: 7, issue_url: "https://github.com/octo/repo/issues/42" }]),
				success: true,
			},
		]);
		const resolution = resolvePublicationOutput({
			operations: [writeOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([{ kind: "conversation", id: 9 }]);
	});

	it("scopes to the write fragment's JSON result and ignores a read fragment's listing", () => {
		const output = JSON.stringify([
			{
				query: "gh api repos/octo/repo/issues/5/comments -f body=x",
				result: JSON.stringify({ id: 9, issue_url: "https://github.com/octo/repo/issues/42" }),
				success: true,
			},
			{
				query: "gh api repos/octo/repo/issues/5/comments",
				result: JSON.stringify([
					{ id: 1, issue_url: "https://github.com/octo/repo/issues/42" },
					{ id: 2, issue_url: "https://github.com/octo/repo/issues/42" },
				]),
				success: true,
			},
		]);
		const resolution = resolvePublicationOutput({
			operations: [
				{
					operation: "gh api",
					kind: "conversation",
					explicitRepository: "octo/repo",
					explicitNumber: 5,
					fragment: "gh api repos/octo/repo/issues/5/comments -f body=x",
					bareIdOutput: false,
				},
			],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([{ kind: "conversation", id: 9 }]);
	});

	it("still publishes from a structured entry whose result is plain text", () => {
		const output = JSON.stringify([
			{
				query: "gh pr comment -b 'addressing'",
				result: "https://github.com/octo/repo/pull/42#issuecomment-11",
				success: true,
			},
		]);
		const resolution = resolvePublicationOutput({
			operations: [writeOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([{ kind: "conversation", id: 11 }]);
	});
});

describe("resolvePublicationOutput multi-object guard", () => {
	const commentOperation: PrPublicationOperation = {
		operation: "gh pr comment",
		kind: "conversation",
		explicitRepository: null,
		explicitNumber: null,
		fragment: "gh pr comment -b 'addressing'",
		bareIdOutput: false,
	};

	it("treats a listing mixed into the write's own output as uncertain", () => {
		const output = JSON.stringify([
			{ id: 9, issue_url: "https://github.com/octo/repo/issues/42" },
			{ id: 7, issue_url: "https://github.com/octo/repo/issues/42" },
		]);
		const resolution = resolvePublicationOutput({
			operations: [commentOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
		expect(resolution.reason).toContain("several GitHub objects");
	});

	it("treats a multi-object output that yields no identities as uncertain, not URL-scannable", () => {
		const output = JSON.stringify([{ name: "a" }, { name: "b" }]);
		const resolution = resolvePublicationOutput({
			operations: [commentOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
	});

	it("still publishes a single attributable response object", () => {
		const output = JSON.stringify({ id: 9, issue_url: "https://github.com/octo/repo/issues/42" });
		const resolution = resolvePublicationOutput({
			operations: [commentOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([{ kind: "conversation", id: 9 }]);
	});

	it("still fails cleanly on a clear CLI failure", () => {
		const resolution = resolvePublicationOutput({
			operations: [commentOperation],
			target: TARGET,
			output: "gh: failed to create comment",
			error: null,
		});
		expect(resolution.status).toBe("failed");
		expect(resolution.identities).toEqual([]);
	});
});

describe("detectPublicationOperations gh pr review forms", () => {
	it.each([
		"gh pr review 42 -c -b 'addressed'",
		"gh pr review 42 --comment -b 'addressed'",
		"gh pr review 42 -r -b 'needs work'",
		"gh pr review 42 --request-changes --body 'needs work'",
		"gh pr review 42 -a -b 'looks good'",
		"gh pr review 42 --approve --body='looks good'",
	])("recognizes %s as a review publication", (fragment) => {
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh pr review",
				kind: "review",
				explicitRepository: null,
				explicitNumber: 42,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it("ignores a bare approval, which publishes no feedback text", () => {
		expect(detectPublicationOperations(["gh pr review 42 --approve", "gh pr review 42 -a"])).toEqual([]);
	});
});

describe("detectPublicationOperations gh api repo placeholders", () => {
	it.each([
		"gh api repos/{owner}/{repo}/issues/42/comments -f body='addressing'",
		"gh api repos/:owner/:repo/issues/42/comments -f body='addressing'",
	])("treats %s as an implicit repository selector", (fragment) => {
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api",
				kind: "conversation",
				explicitRepository: null,
				explicitNumber: 42,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it("attributes a placeholder write to the single linked PR instead of dropping it", () => {
		const observation = analyzePrPublication({
			toolName: "run_command",
			commands: ["gh api repos/{owner}/{repo}/issues/42/comments -f body='addressing'"],
			output: JSON.stringify({
				id: 77,
				issue_url: "https://api.github.com/repos/octo/repo/issues/42",
				html_url: "https://github.com/octo/repo/pull/42#issuecomment-77",
			}),
			error: null,
			linkedPullRequests: [TARGET],
		});
		expect(observation.status).toBe("published");
		expect(observation.target).toEqual(TARGET);
		expect(observation.identities).toEqual([{ kind: "conversation", id: 77 }]);
	});
});

describe("detectPublicationOperations wrapped gh invocations", () => {
	it.each([
		"timeout 30 gh pr comment 42 -b 'addressed'",
		"env GH_DEBUG=1 gh pr comment 42 -b 'addressed'",
		"command gh pr comment 42 -b 'addressed'",
		"/usr/bin/gh pr comment 42 -b 'addressed'",
	])("detects %s", (fragment) => {
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh pr comment",
				kind: "conversation",
				explicitRepository: null,
				explicitNumber: 42,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it.each([
		["bash -c \"gh pr comment 42 -b 'addressed'\"", "gh pr comment 42 -b 'addressed'"],
		[
			"sh -lc 'gh api repos/octo/repo/issues/42/comments -f body=x'",
			"gh api repos/octo/repo/issues/42/comments -f body=x",
		],
	])("detects the gh call inside %s", (command, inner) => {
		const operations = detectPublicationOperations([command]);
		expect(operations).toHaveLength(1);
		expect(operations[0]?.fragment).toBe(inner);
		expect(operations[0]?.explicitNumber).toBe(42);
	});

	it("ignores gh text that is only an argument of another command", () => {
		expect(
			detectPublicationOperations(["rg 'gh pr comment' src", 'echo "gh api repos/o/r/issues/1/comments"']),
		).toEqual([]);
	});
});

describe("detectPublicationOperations gh api attached payload forms", () => {
	it.each([
		["gh api repos/octo/repo/issues/5/comments --field=body=x", "conversation"],
		["gh api repos/octo/repo/issues/5/comments --raw-field=body=x", "conversation"],
		["gh api repos/octo/repo/issues/5/comments -fbody=x", "conversation"],
		["gh api repos/octo/repo/issues/5/comments -Fbody=@reply.md", "conversation"],
		["gh api repos/octo/repo/pulls/5/reviews --input=review.json", "review"],
	])("treats %s as a write", (fragment, kind) => {
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api",
				kind,
				explicitRepository: "octo/repo",
				explicitNumber: 5,
				fragment,
				bareIdOutput: false,
			},
		]);
	});

	it("reads a graphql query passed as --field=query=... for the mutation check", () => {
		expect(detectPublicationOperations(["gh api graphql --field=query='query { viewer { login } }'"])).toEqual([]);
		expect(
			detectPublicationOperations([
				"gh api graphql --field=query='mutation { addComment(input: {}) { clientMutationId } }'",
			]),
		).toHaveLength(1);
	});
});

describe("detectPublicationOperations graphql feedback mutations", () => {
	it.each([
		"gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {}) { comment { id } } }'",
		"gh api graphql -f query='mutation { addPullRequestReviewThread(input: {}) { thread { id } } }'",
		"gh api graphql -f query='mutation { submitPullRequestReview(input: {}) { pullRequestReview { id } } }'",
		"gh api graphql -f query='mutation { addComment (input: {}) { clientMutationId } }'",
		"gh api graphql -F query=@reply.graphql",
	])("treats %s as an unattributable publication", (fragment) => {
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api graphql",
				kind: null,
				explicitRepository: null,
				explicitNumber: null,
				fragment,
				bareIdOutput: false,
			},
		]);
	});
});

describe("detectPublicationOperations multi-line commands", () => {
	it("joins backslash-newline continuations into one gh api write", () => {
		const command = "gh api repos/octo/repo/issues/5/comments \\\n  -f body='Fixed'";
		expect(detectPublicationOperations([command])).toEqual([
			{
				operation: "gh api",
				kind: "conversation",
				explicitRepository: "octo/repo",
				explicitNumber: 5,
				fragment: command,
				bareIdOutput: false,
			},
		]);
	});

	it("reads the method and endpoint across continuation lines", () => {
		const command = "gh api -X POST \\\n  repos/octo/repo/pulls/5/comments/9/replies \\\n  -f body=x";
		expect(detectPublicationOperations([command])).toMatchObject([{ kind: "inline", explicitNumber: 5 }]);
	});

	it("recognizes a gh pr review flag on a continuation line", () => {
		expect(detectPublicationOperations(["gh pr review 5 \\\n  --comment -b 'addressed'"])).toMatchObject([
			{ operation: "gh pr review", explicitNumber: 5 },
		]);
	});

	it("keeps a quoted multi-line graphql query in one fragment", () => {
		const command = "gh api graphql -f query='\n  mutation {\n    addComment(input: {}) { clientMutationId }\n  }'";
		expect(detectPublicationOperations([command])).toHaveLength(1);
		expect(detectPublicationOperations(["gh api graphql -f query='\n  query {\n    viewer { login }\n  }'"])).toEqual(
			[],
		);
	});

	it("still splits real command separators", () => {
		expect(
			detectPublicationOperations(["git push && gh pr comment 5 -b 'a; b'\necho done | cat"]).map(
				(operation) => operation.fragment,
			),
		).toEqual(["gh pr comment 5 -b 'a; b'"]);
	});
});

describe("resolvePublicationOutput never reads the echoed command text", () => {
	const reviewOperation: PrPublicationOperation = {
		operation: "gh pr review",
		kind: "review",
		explicitRepository: null,
		explicitNumber: 42,
		fragment: "gh pr review 42 --comment --body 'fixed the GraphQL query'",
		bareIdOutput: false,
	};

	it("does not classify a successful write as failed because its body mentions GraphQL", () => {
		const output = JSON.stringify([{ query: reviewOperation.fragment, result: "", success: true }]);
		const resolution = resolvePublicationOutput({
			operations: [reviewOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("uncertain");
	});

	it("still treats an anchored gh GraphQL error as a failure", () => {
		const output = JSON.stringify([
			{ query: reviewOperation.fragment, result: "GraphQL: Could not resolve to a PullRequest", success: false },
		]);
		const resolution = resolvePublicationOutput({
			operations: [reviewOperation],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("failed");
	});

	it("never registers a URL quoted in the command when no entry matches the fragment", () => {
		// Restart recovery (empty fragment) or a wrapped inner fragment: the
		// echoed query cites a reviewer comment; only the result is evidence.
		const output = JSON.stringify([
			{
				query: 'bash -c "gh pr comment 42 --body \\"see https://github.com/octo/repo/pull/42#issuecomment-111\\""',
				result: "https://github.com/octo/repo/pull/42#issuecomment-222",
				success: true,
			},
		]);
		const resolution = resolvePublicationOutput({
			operations: [{ ...reviewOperation, operation: "gh pr comment", kind: "conversation", fragment: "" }],
			target: TARGET,
			output,
			error: null,
		});
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([{ kind: "conversation", id: 222 }]);
	});
});

describe("analyzePrPublication finished phase without output", () => {
	it("classifies a finished write with no output and a gh error as failed, not pending", () => {
		const observation = analyzePrPublication({
			toolName: "run_command",
			commands: ["gh pr comment 42 -b 'addressing'"],
			phase: "finished",
			output: null,
			error: "gh: HTTP 404: Not Found",
			linkedPullRequests: [TARGET],
		});
		expect(observation.status).toBe("failed");
	});

	it("keeps the started phase pending", () => {
		const observation = analyzePrPublication({
			toolName: "run_command",
			commands: ["gh pr comment 42 -b 'addressing'"],
			phase: "started",
			output: null,
			error: null,
			linkedPullRequests: [TARGET],
		});
		expect(observation.status).toBe("pending");
	});
});

describe("detectPublicationOperations edit endpoints", () => {
	it.each([
		"gh api --method PATCH repos/octo/repo/pulls/comments/4289424243 -f 'body=addressed' --jq '.body'",
		"gh api --method PATCH repos/octo/repo/issues/comments/4289424243 -f 'body=addressed'",
		"gh api --method PATCH repos/octo/repo/pulls/42/reviews/7 -f 'body=addressed'",
	])("does not treat %s as a new publication", (fragment) => {
		expect(detectPublicationOperations([fragment])).toEqual([]);
	});

	it("keeps create/reply endpoints as publications and marks bare-id output", () => {
		const fragment = "gh api repos/octo/repo/pulls/42/comments/9/replies -f body='addressed' --jq '.id'";
		expect(detectPublicationOperations([fragment])).toEqual([
			{
				operation: "gh api",
				kind: "inline",
				explicitRepository: "octo/repo",
				explicitNumber: 42,
				fragment,
				bareIdOutput: true,
			},
		]);
	});

	it.each([
		"gh api repos/octo/repo/issues/5/comments -f body='addressed' -q '.id'",
		"gh api repos/octo/repo/issues/5/comments --field=body=addressed --jq='.id'",
	])("treats %s as a bare-id output write", (fragment) => {
		expect(detectPublicationOperations([fragment])).toMatchObject([
			{ kind: "conversation", explicitNumber: 5, bareIdOutput: true },
		]);
	});

	it("does not mark other jq filters as bare-id output", () => {
		const fragment = "gh api repos/octo/repo/issues/5/comments -f body='addressed' --jq '.html_url'";
		expect(detectPublicationOperations([fragment])).toMatchObject([{ kind: "conversation", bareIdOutput: false }]);
	});

	it("reports edit-only activity when every write edits existing feedback", () => {
		expect(
			isEditOnlyPublicationActivity([
				"gh api --method PATCH repos/octo/repo/pulls/comments/4289424243 -f 'body=x' --jq '.body'",
				"gh api --method PATCH repos/octo/repo/pulls/42/reviews/7 -f 'body=y'",
			]),
		).toBe(true);
	});

	it("does not report edit-only activity when a create is present", () => {
		expect(
			isEditOnlyPublicationActivity([
				"gh api --method PATCH repos/octo/repo/pulls/comments/4289424243 -f 'body=x'",
				"gh pr comment 42 -b 'addressed'",
			]),
		).toBe(false);
	});

	it("does not report edit-only activity for reads or empty commands", () => {
		expect(isEditOnlyPublicationActivity(["gh api repos/octo/repo/pulls/42/comments"])).toBe(false);
		expect(isEditOnlyPublicationActivity([])).toBe(false);
	});
});

describe("resolvePublicationOutput bare numeric id support", () => {
	const verifiedTarget: PrPublicationTarget = {
		host: "github.com",
		repository: "billy-the-ape/ai-gateway",
		number: 229,
	};
	const verifiedCommand = [
		"gh api repos/billy-the-ape/ai-gateway/pulls/229/comments/4288990294/replies -f \"body=Addressed.\" --jq '.id'",
		"gh api repos/billy-the-ape/ai-gateway/pulls/229/comments/4288990316/replies -f \"body=Addressed.\" --jq '.id'",
	].join("\n");

	it("registers both bare reply ids from the verified compound-command result", () => {
		const operations = detectPublicationOperations([verifiedCommand]);
		expect(operations).toHaveLength(2);
		const output = JSON.stringify([{ query: verifiedCommand, result: "4289427635\n4289427764", success: true }]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([
			{ kind: "inline", id: 4289427635 },
			{ kind: "inline", id: 4289427764 },
		]);
	});

	it("publishes the verified transcript end to end through analyzePrPublication", () => {
		const observation = analyzePrPublication({
			toolName: "run_command",
			commands: [verifiedCommand],
			phase: "finished",
			output: JSON.stringify([{ query: verifiedCommand, result: "4289427635\n4289427764", success: true }]),
			error: null,
			linkedPullRequests: [verifiedTarget],
		});
		expect(observation.status).toBe("published");
		expect(observation.target).toEqual(verifiedTarget);
		expect(observation.identities).toEqual([
			{ kind: "inline", id: 4289427635 },
			{ kind: "inline", id: 4289427764 },
		]);
	});

	it("registers a single bare id from a supported numeric response", () => {
		const fragment =
			"gh api repos/billy-the-ape/ai-gateway/pulls/229/comments/4288990294/replies -f \"body=Addressed.\" --jq '.id'";
		const operations = detectPublicationOperations([fragment]);
		const output = JSON.stringify([{ query: fragment, result: "4289427635", success: true }]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([{ kind: "inline", id: 4289427635 }]);
	});

	it("never registers bare numbers from a write without a bare-id filter", () => {
		const fragment =
			'gh api repos/billy-the-ape/ai-gateway/pulls/229/comments/4288990294/replies -f "body=Addressed."';
		const operations = detectPublicationOperations([fragment]);
		const output = JSON.stringify([{ query: fragment, result: "4289427635", success: true }]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
	});

	it("treats a bare-id count mismatch as uncertain", () => {
		const operations = detectPublicationOperations([verifiedCommand]);
		const output = JSON.stringify([{ query: verifiedCommand, result: "4289427635", success: true }]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
		expect(resolution.reason).toContain("bare numeric output");
	});

	it("treats mixed evidence with extra output lines as uncertain", () => {
		const operations = detectPublicationOperations([verifiedCommand]);
		const output = JSON.stringify([
			{ query: verifiedCommand, result: "4289427635\n4289427764\ndone", success: true },
		]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
	});

	it("treats a partial failure across the scoped writes as uncertain", () => {
		const operations = detectPublicationOperations([verifiedCommand]);
		const [first, second] = verifiedCommand.split("\n");
		const output = JSON.stringify([
			{ query: first, result: "4289427635", success: true },
			{ query: second, result: "gh: HTTP 422: Unprocessable Entity", success: false },
		]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
		expect(resolution.reason).toContain("bare numeric output");
	});

	it("keeps bare ids scoped away from an unrelated read result", () => {
		const operations = detectPublicationOperations([verifiedCommand]);
		const output = JSON.stringify([
			{ query: verifiedCommand, result: "4289427635\n4289427764", success: true },
			{
				query: "gh api repos/billy-the-ape/ai-gateway/pulls/229/comments",
				result: "1234567890",
				success: true,
			},
		]);
		const resolution = resolvePublicationOutput({ operations, target: verifiedTarget, output, error: null });
		expect(resolution.status).toBe("published");
		expect(resolution.identities).toEqual([
			{ kind: "inline", id: 4289427635 },
			{ kind: "inline", id: 4289427764 },
		]);
	});

	it("rejects mixed kinds among bare-id writes", () => {
		const command = [
			"gh api repos/octo/repo/pulls/42/comments/9/replies -f body='addressed' --jq '.id'",
			"gh api repos/octo/repo/issues/42/comments -f body='addressed' --jq '.id'",
		].join("\n");
		const operations = detectPublicationOperations([command]);
		const output = JSON.stringify([{ query: command, result: "111\n222", success: true }]);
		const resolution = resolvePublicationOutput({ operations, target: TARGET, output, error: null });
		expect(resolution.status).toBe("uncertain");
		expect(resolution.identities).toEqual([]);
		expect(resolution.reason).toContain("bare numeric output");
	});
});
