// AR-5: verifies the publication patterns the safe publication guidance
// prescribes, using a local stub `gh` that captures argv and input-file
// bytes. No real remote writes happen: the stub never touches the network.
// These are shell-pattern tests, not live-model compliance tests.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTempDir } from "../../utilities/temp-dir";

// The Markdown body the guidance says to write as UTF-8 to a file:
// backticks, `$(...)` and backtick substitution, a `$HOME` reference,
// double and single quotes, unicode, and a blank line, plus a trailing
// newline. The markers make "no interpolation executed" observable.
function buildFixtureBody(workdir: string) {
	const commandSubstitutionMarker = join(workdir, "marker-command-substitution");
	const backtickSubstitutionMarker = join(workdir, "marker-backtick-substitution");
	const lines = [
		"# Release notes",
		"",
		"A line with `inline backticks` and a $HOME reference.",
		`A line with $(touch ${commandSubstitutionMarker}) command substitution.`,
		`A line with \`touch ${backtickSubstitutionMarker}\` backtick substitution.`,
		"A line with \"double quotes\" and 'single quotes'.",
		"Unicode: émojis ✓ — 日本語",
		"",
	];
	const body = `${lines.join("\n")}\n`;
	return { body, commandSubstitutionMarker, backtickSubstitutionMarker };
}

/** A stub `gh` that records argv and copies `--body-file`/`--input` payloads. */
const STUB_GH_SCRIPT = `#!/bin/sh
{
  for arg in "$@"; do
    printf 'ARG:%s\\n' "$arg"
  done
} > argv.txt
prev=""
for arg in "$@"; do
  case "$prev" in
    --body-file) cp "$arg" captured.md ;;
    --input) cp "$arg" captured.json ;;
  esac
  prev="$arg"
done
`;

function runShell(workdir: string, binDir: string, command: string) {
	const result = spawnSync("bash", ["-c", command], {
		cwd: workdir,
		env: {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
		},
		encoding: "utf8",
	});
	return result;
}

describe.sequential("AR-5 safe publication body patterns", () => {
	it("keeps --body-file Markdown bytes exact and runs no shell interpolation", () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: workdir, cleanup } = createTempDir("kanban-ar5-body-file-");
		const { path: binDir, cleanup: cleanupBin } = createTempDir("kanban-ar5-gh-bin-");
		try {
			writeFileSync(join(binDir, "gh"), STUB_GH_SCRIPT, "utf8");
			chmodSync(join(binDir, "gh"), 0o755);

			const { body, commandSubstitutionMarker, backtickSubstitutionMarker } = buildFixtureBody(workdir);
			const heredocLines = body.replace(/\n$/, "").split("\n");
			const command = [
				"set -e",
				"cat > body.md << 'AR5_FIXTURE_EOF'",
				...heredocLines,
				"AR5_FIXTURE_EOF",
				'gh pr create --repo owner/repo --title "Release notes" --body-file body.md',
			].join("\n");
			const result = runShell(workdir, binDir, command);
			expect(result.status).toBe(0);

			// The stub captured exactly the intended body bytes: real newlines,
			// quotes, unicode, and a trailing newline — unmodified.
			expect(readFileSync(join(workdir, "captured.md"), "utf8")).toBe(body);
			// No shell interpolation executed inside the quoted heredoc.
			expect(existsSync(commandSubstitutionMarker)).toBe(false);
			expect(existsSync(backtickSubstitutionMarker)).toBe(false);
			// The stub received the documented invocation shape.
			const argvLog = readFileSync(join(workdir, "argv.txt"), "utf8");
			expect(argvLog).toContain("ARG:--body-file");
			expect(argvLog).toContain("ARG:body.md");
		} finally {
			cleanup();
			cleanupBin();
		}
	});

	it("preserves structured input bytes on the non-CLI path", () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: workdir, cleanup } = createTempDir("kanban-ar5-structured-");
		const { path: binDir, cleanup: cleanupBin } = createTempDir("kanban-ar5-gh-bin-2-");
		try {
			writeFileSync(join(binDir, "gh"), STUB_GH_SCRIPT, "utf8");
			chmodSync(join(binDir, "gh"), 0o755);

			const { body } = buildFixtureBody(workdir);
			// The structured input is written with the filesystem API (no
			// shell escaping involved) and passed as a file to `gh api`.
			writeFileSync(join(workdir, "payload.json"), JSON.stringify({ body }), "utf8");
			const command = "gh api repos/owner/repo/pulls/1/comments --input payload.json";
			const result = runShell(workdir, binDir, command);
			expect(result.status).toBe(0);

			const payload = JSON.parse(readFileSync(join(workdir, "captured.json"), "utf8")) as {
				body?: string;
			};
			expect(payload.body).toBe(body);
		} finally {
			cleanup();
			cleanupBin();
		}
	});
});
