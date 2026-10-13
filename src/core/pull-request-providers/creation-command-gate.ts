// PRLINK-9: the existing pure PR-creation command gate rules.
//
// Shared by `src/core/pull-request-detection.ts` (server) and available to
// future provider-specific capture paths. Pure string/token logic: no exec,
// no environment, no I/O.
const COMMAND_FRAGMENT_SPLIT_PATTERN = /&&|\|\||;|\||\r?\n/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Splits a command line at unquoted-ish shell operators and newlines. */
export function splitCommandFragments(command: string): string[] {
	return command
		.split(COMMAND_FRAGMENT_SPLIT_PATTERN)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
}

/** Tokenizes a fragment, skipping leading env assignments (`FOO=bar cmd`). */
export function tokenizeCommandFragment(fragment: string): string[] {
	const tokens = fragment.split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[index] ?? "")) {
		index += 1;
	}
	return tokens.slice(index);
}

export function firstNonFlagToken(tokens: string[], fromIndex: number): string | null {
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
export function isPrCreatingCommand(tokens: string[]): boolean {
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

/** True when any fragment of the command invokes a PR-creating command. */
export function commandHasPrCreatingSegment(command: string): boolean {
	return splitCommandFragments(command).some((fragment) => isPrCreatingCommand(tokenizeCommandFragment(fragment)));
}

/** True for MCP tools that create a pull request or merge request. */
export function isPrCreatingMcpTool(toolName: string | null): boolean {
	if (!toolName) {
		return false;
	}
	return toolName.endsWith("create_pull_request") || toolName.endsWith("create_merge_request");
}
