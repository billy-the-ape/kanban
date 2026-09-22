// B-6.6: tool policy for bounded review sessions.
//
// A review session may read anything inside the task worktree and run
// read-only commands, but it must not publish work (`git push`,
// `git commit`), must not discard worktree state (`git reset --hard`,
// forced `git clean`, `rm -rf .git`), and may only write files that are
// part of the reviewed change set (or the task plan doc). Command checks
// are best-effort scans of the tool input, so the policy is a guardrail,
// not a sandbox: commands that cannot be classified fall through to the
// default Kanban approval behavior (approved).
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ClineSdkToolApprovalRequest, ClineSdkToolApprovalResult } from "./sdk-runtime-boundary";

export type ReviewToolApprovalHandler = (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;

export interface CreateReviewToolPolicyOptions {
	/** Absolute path to the task worktree (anchor for write-path scoping). */
	worktreePath: string;
	/** Worktree-relative paths the review session may create or modify. */
	allowedWritePaths: readonly string[];
}

const COMMAND_TOOL_NAMES = new Set(["run_commands", "bash"]);
const EDITOR_TOOL_NAMES = new Set(["editor", "write_to_file", "replace_in_file"]);
const APPLY_PATCH_TOOL_NAME = "apply_patch";
const READ_TOOL_NAMES = new Set(["read_files", "list_files", "search_codebase", "search_files", "fetch_web_content"]);
// File header lines of the block-form patch ("*** Add File: <path>", ...).
const PATCH_FILE_HEADER_PATTERN = /^\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a `run_commands` tool input to raw command strings. The SDK
 * accepts a string, an array, a `{ commands: [...] }` object, or structured
 * `{ command, args }` entries; all variants are reduced to joined strings
 * so the deny checks below work uniformly.
 */
function extractCommandStrings(input: unknown): string[] {
	const commands: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.trim()) {
				commands.push(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				const command = normalizeCommandEntry(entry);
				if (command) {
					commands.push(command);
				}
			}
			return;
		}
		if (isRecord(value)) {
			for (const key of ["commands", "command", "cmd"]) {
				const candidate = value[key];
				if (typeof candidate === "string" || Array.isArray(candidate)) {
					collect(candidate);
				}
			}
		}
	};
	collect(input);
	return commands;
}

function normalizeCommandEntry(entry: unknown): string | null {
	if (typeof entry === "string") {
		const trimmed = entry.trim();
		return trimmed ? entry : null;
	}
	if (isRecord(entry)) {
		const base = typeof entry.command === "string" ? entry.command : typeof entry.cmd === "string" ? entry.cmd : null;
		if (base === null) {
			return null;
		}
		const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		const joined = [base, ...args].join(" ").trim();
		return joined ? joined : null;
	}
	return null;
}
/**
 * Finds the first bare `git` token and the subcommand that follows it,
 * skipping git's global options (`git -C repo push` → `push`). Returns null
 * when the fragment has no git invocation or when `--` is reached before a
 * subcommand (anything after it is a pathspec, not a subcommand).
 */
function locateGitSubcommand(tokens: string[]): { subcommand: string; rest: string[] } | null {
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i] !== "git") {
			continue;
		}
		let j = i + 1;
		while (j < tokens.length) {
			const token = tokens[j] ?? "";
			if (token === "--") {
				return null;
			}
			if (token.startsWith("--")) {
				j += token.includes("=") ? 1 : 2;
				continue;
			}
			if (token.startsWith("-") && token.length > 1) {
				const flag = token.charAt(1);
				j += token.length === 2 && (flag === "c" || flag === "C") ? 2 : 1;
				continue;
			}
			return { subcommand: token, rest: tokens.slice(j + 1) };
		}
		return null;
	}
	return null;
}

/** Splits a command line into fragments at unquoted shell operators. */
function splitCommandFragments(command: string): string[] {
	const masked = command
		.replace(/'(?:[^'\\]|\\.)*'/g, " '' ")
		.replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
		.replace(/`[^`]*`/g, " `` ");
	return masked
		.split(/&&|\|\||;|\||\r?\n/)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
}

/** True for `rm -rf <something ending in .git>` style invocations. */
function isDestructiveGitRemoval(tokens: string[]): boolean {
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) {
		i += 1; // skip env var assignments such as `FOO=bar rm -rf ...`
	}
	const command = tokens[i] ?? "";
	if (command !== "rm" && !/\/rm$/.test(command)) {
		return false;
	}
	let recursive = false;
	let force = false;
	let targetsGitDir = false;
	for (const token of tokens.slice(i + 1)) {
		if (token.startsWith("-") && token.length > 1) {
			if (/[rR]/.test(token)) {
				recursive = true;
			}
			if (/f/.test(token)) {
				force = true;
			}
			continue;
		}
		if (token === ".git" || token.endsWith("/.git")) {
			targetsGitDir = true;
		}
	}
	return recursive && force && targetsGitDir;
}

function checkCommandFragment(fragment: string): string | null {
	const tokens = fragment.split(/\s+/).filter(Boolean);
	const git = locateGitSubcommand(tokens);
	if (git) {
		if (git.subcommand === "push") {
			return "git push is not allowed in review sessions; Kanban owns Git delivery.";
		}
		if (git.subcommand === "commit") {
			return "git commit is not allowed in review sessions; Kanban owns Git delivery.";
		}
		if (git.subcommand === "reset" && git.rest.some((token) => token === "--hard" || token === "--merge")) {
			return "git reset --hard is not allowed in review sessions; review fixes must not discard work.";
		}
		if (
			git.subcommand === "clean" &&
			git.rest.some((token) => token.startsWith("-") && token.length > 1 && /[fF]/.test(token))
		) {
			return "forced git clean is not allowed in review sessions; untracked work must not be deleted.";
		}
	}
	if (isDestructiveGitRemoval(tokens)) {
		return "removing the .git directory is not allowed in review sessions.";
	}
	return null;
}

/** Returns the denial reason when `command` is a forbidden review-session command, else null. */
export function findDeniedReviewCommand(command: string): string | null {
	for (const fragment of splitCommandFragments(command)) {
		const denial = checkCommandFragment(fragment);
		if (denial) {
			return denial;
		}
	}
	return null;
}

/** Resolves a tool-input path against the worktree, returning a worktree-relative path or null. */
function toWorktreeRelative(worktreePath: string, candidatePath: unknown): string | null {
	if (typeof candidatePath !== "string") {
		return null;
	}
	const trimmed = candidatePath.trim();
	if (!trimmed) {
		return null;
	}
	const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(worktreePath, trimmed);
	const rel = relative(worktreePath, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
		return null;
	}
	return rel.split(sep).join("/");
}

/** Extracts every file a block-form `apply_patch` input touches. */
function extractPatchPaths(input: unknown): string[] {
	let patchText: string | null = null;
	if (typeof input === "string") {
		patchText = input;
	} else if (isRecord(input) && typeof input.input === "string") {
		patchText = input.input;
	}
	if (patchText === null) {
		return [];
	}
	const paths: string[] = [];
	for (const match of patchText.matchAll(PATCH_FILE_HEADER_PATTERN)) {
		const path = match[1];
		if (path) {
			paths.push(path);
		}
	}
	return paths;
}

/**
 * Builds the tool approval handler for a review session: unclassified
 * tools and commands are approved (the default Kanban approval behavior),
 * while delivery/destructive git commands and out-of-scope writes are
 * denied with an explanatory reason the reviewer can act on.
 */
export function createReviewToolPolicy(options: CreateReviewToolPolicyOptions): ReviewToolApprovalHandler {
	const { worktreePath } = options;
	const allowedWritePaths = new Set(
		options.allowedWritePaths.map((path) => path.split(sep).join("/")).filter(Boolean),
	);

	return async (request: ClineSdkToolApprovalRequest): Promise<ClineSdkToolApprovalResult> => {
		const toolName = request.toolName;
		const input = isRecord(request.input) ? request.input : {};

		if (toolName === "submit" || READ_TOOL_NAMES.has(toolName)) {
			return { approved: true };
		}

		if (COMMAND_TOOL_NAMES.has(toolName)) {
			for (const command of extractCommandStrings(input)) {
				const denial = findDeniedReviewCommand(command);
				if (denial) {
					return { approved: false, reason: denial };
				}
			}
			return { approved: true };
		}

		if (EDITOR_TOOL_NAMES.has(toolName)) {
			const relPath = toWorktreeRelative(worktreePath, input.path);
			if (relPath && allowedWritePaths.has(relPath)) {
				return { approved: true };
			}
			return {
				approved: false,
				reason: `Review sessions may only modify reviewed files (requested ${relPath ?? String(input.path ?? "")}).`,
			};
		}

		if (toolName === APPLY_PATCH_TOOL_NAME) {
			const paths = extractPatchPaths(input);
			if (paths.length > 0) {
				for (const path of paths) {
					const relPath = toWorktreeRelative(worktreePath, path);
					if (!relPath || !allowedWritePaths.has(relPath)) {
						return {
							approved: false,
							reason: `Review sessions may only modify reviewed files (patch targets ${relPath ?? path}).`,
						};
					}
				}
				return { approved: true };
			}
			return { approved: false, reason: "Review sessions may only modify reviewed files (unparseable patch)." };
		}

		// Unknown tools (SDK-specific extras): defer to default approval.
		return { approved: true };
	};
}
