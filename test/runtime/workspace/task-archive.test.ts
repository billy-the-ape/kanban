import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTaskArchive } from "../../../src/workspace/task-archive";

describe.skipIf(process.platform === "win32").sequential("task archive subprocess", () => {
	let directory: string;
	let previousPath: string | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "kanban-archive-command-"));
		previousPath = process.env.PATH;
		process.env.PATH = directory;
	});

	afterEach(async () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	});

	async function installTar(body: string): Promise<void> {
		await writeFile(join(directory, "tar"), `#!${process.execPath}\n${body}`, { mode: 0o755 });
	}

	it("lets a successful archive finish despite multi-megabyte output", async () => {
		const marker = join(directory, "completed");
		await installTar(`
import { writeFileSync } from 'node:fs';
process.stdout.write('output'.repeat(400000));
process.stderr.write('warning'.repeat(400000), () => {
  writeFileSync(${JSON.stringify(marker)}, 'done');
});
`);
		await expect(runTaskArchive(["xzf", "archive.tar.gz"])).resolves.toBeUndefined();
		expect(await readFile(marker, "utf8")).toBe("done");
	});

	it("reports the real exit code with bounded first and last diagnostics", async () => {
		await installTar(`
process.stderr.write('FIRST ERROR\\n' + 'warning'.repeat(400000) + '\\nLAST ERROR', () => {
  process.exitCode = 2;
});
`);
		const error = await runTaskArchive([]).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) throw new Error("Expected tar failure");
		expect(error.message).toContain("exit 2");
		expect(error.message).toContain("FIRST ERROR");
		expect(error.message).toContain("LAST ERROR");
		expect(error.message).toContain("diagnostics truncated");
		expect(error.message.length).toBeLessThan(17000);
	});

	it("reports a signaled process as a failure", async () => {
		await installTar("process.kill(process.pid, 'SIGTERM');");
		await expect(runTaskArchive([])).rejects.toThrow("signal SIGTERM");
	});

	it("reports a missing tar executable", async () => {
		await expect(runTaskArchive([])).rejects.toThrow("ENOENT");
	});
});
