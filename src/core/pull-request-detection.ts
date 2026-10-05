// PRLINK-0: narrow PR-creation detection gate.
//
// Returns linked pull requests ONLY when the tool call itself creates a PR
// (gh/glab/hub creation commands, `git push -o merge_request.create`, or an
// MCP create_pull_request / create_merge_request tool). Links are parsed
// from the tool output only — never from the command text — so review
// sessions reading PRs (`gh pr view`) adopt nothing. Misses are recoverable
// via deterministic delivery, branch lookup (PRLINK-5), or manual add.
import { extractCommandStrings } from "../cline-sdk/review-tool-policy";
import type { ParsedPullRequestLink } from "./pull-request-links";
import { extractPullRequestLinks, parsePullRequestUrl } from "./pull-request-links";

export interface PullRequestDetectionInput {
	toolName: string | null;
	/** Already-normalized raw command strings (see extractCommandStrings). */
	commands: string[];
	output: string | null;
}

const COMMAND_FRAGMENT_SPLIT_PATTERN = /&&|\|\||;|\||\r?\n/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_STRUCTURED_OUTPUT_DEPTH = 4;

/** Splits a command line at unquoted-ish shell operators and newlines. */
function splitCommandFragments(command: string): string[] {
	return command
		.split(COMMAND_FRAGMENT_SPLIT_PATTERN)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
}

/** Tokenizes a fragment, skipping leading env assignments (`FOO=bar cmd`). */
function tokenizeCommandFragment(fragment: string): string[] {
	const tokens = fragment.split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[index] ?? "")) {
		index += 1;
	}
	return tokens.slice(index);
}

function firstNonFlagToken(tokens: string[], fromIndex: number): string | null {
	for (let i = fromIndex; i < tokens.length; i += 1) {
		const token = tokens[i] ?? "";
		if (!token.startsWith("-")) {
			return token;
		}
	}
	return null;
}

/**
 * True when the fragment invokes a PR-creating command:
 * `gh pr create`, `glab mr create`, `hub pull-request`, or
 * `git push ... -o merge_request.create`.
 */
function isPrCreatingCommand(tokens: string[]): boolean {
	const command = tokens[0] ?? "";
	switch (command) {
		case "gh": {
			const group = firstNonFlagToken(tokens, 1);
			const action = firstNonFlagToken(tokens, 2);
			return group === "pr" && action === "create";
		}
		case "glab": {
			const group = firstNonFlagToken(tokens, 1);
			const action = firstNonFlagToken(tokens, 2);
			return group === "mr" && action === "create";
		}
		case "hub":
			return firstNonFlagToken(tokens, 1) === "pull-request";
		case "git": {
			const subcommand = firstNonFlagToken(tokens, 1);
			if (subcommand !== "push") {
				return false;
			}
			return tokens.slice(2).some((token) => token === "merge_request.create");
		}
		default:
			return false;
	}
}

function commandHasPrCreatingSegment(command: string): boolean {
	return splitCommandFragments(command).some((fragment) => isPrCreatingCommand(tokenizeCommandFragment(fragment)));
}

function isPrCreatingMcpTool(toolName: string | null): boolean {
	if (!toolName) {
		return false;
	}
	return toolName.endsWith("create_pull_request") || toolName.endsWith("create_merge_request");
}

function findWebUrlInValue(value: unknown, depth: number): string | null {
	if (value === null || typeof value !== "object" || depth > MAX_STRUCTURED_OUTPUT_DEPTH) {
		return null;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = findWebUrlInValue(entry, depth + 1);
			if (found) {
				return found;
			}
		}
		return null;
	}
	const record = value as Record<string, unknown>;
	const htmlUrl = record.html_url;
	if (typeof htmlUrl === "string" && htmlUrl.trim()) {
		return htmlUrl.trim();
	}
	const webUrl = record.web_url;
	if (typeof webUrl === "string" && webUrl.trim()) {
		return webUrl.trim();
	}
	for (const nested of Object.values(record)) {
		const found = findWebUrlInValue(nested, depth + 1);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * For MCP creation tools, prefer `html_url` / `web_url` from structured
 * output (a JSON object, or a string containing JSON); fall back to URL
 * scanning over the raw output text.
 */
function detectMcpCreatedPullRequests(output: string | null): ParsedPullRequestLink[] {
	const text = (output ?? "").trim();
	if (!text) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(text);
		const structuredUrl = findWebUrlInValue(parsed, 0);
		if (structuredUrl) {
			const parsedLink = parsePullRequestUrl(structuredUrl);
			if (parsedLink) {
				return [parsedLink];
			}
		}
	} catch {
		// Not structured JSON; fall through to URL scanning.
	}
	return extractPullRequestLinks(text);
}

/**
 * Detects pull requests created by a single tool call. Returns `[]` for
 * everything that does not itself create a PR. Results are deduplicated by
 * identity key in first-appearance order.
 */
export function detectCreatedPullRequests(input: PullRequestDetectionInput): ParsedPullRequestLink[] {
	if (isPrCreatingMcpTool(input.toolName)) {
		return detectMcpCreatedPullRequests(input.output);
	}
	const outputText = input.output ?? "";
	for (const command of extractCommandStrings(input.commands)) {
		if (commandHasPrCreatingSegment(command)) {
			return extractPullRequestLinks(outputText);
		}
	}
	return [];
}
