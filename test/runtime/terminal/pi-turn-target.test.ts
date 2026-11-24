import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiTurnTarget } from "../../../src/terminal/pi-turn-target";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const directories: string[] = [];

async function makeAgentDir() {
	const dir = await mkdtemp(join(tmpdir(), "kanban-pi-turn-target-"));
	directories.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	await mkdir(dir, { recursive: true });
	return dir;
}

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("resolvePiTurnTarget", () => {
	it("discovers the selected model's local llama-swap endpoint without reading credentials", async () => {
		const dir = await makeAgentDir();
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				defaultProvider: "local",
				defaultModel: "qwen3",
			}),
		);
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:8080/v1",
						models: [{ id: "qwen3" }],
						apiKey: "never-forward-to-capacity-probe",
					},
				},
			}),
		);
		expect(await resolvePiTurnTarget()).toEqual({
			providerId: "local",
			modelId: "qwen3",
			baseUrl: "http://127.0.0.1:8080/v1",
		});
	});

	it("respects explicit Pi command model flags", async () => {
		const dir = await makeAgentDir();
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				defaultProvider: "local",
				defaultModel: "qwen3",
			}),
		);
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					other: { baseUrl: "http://127.0.0.1:8181/v1" },
				},
			}),
		);
		expect(await resolvePiTurnTarget(["--provider", "other", "--model", "qwen-coder"])).toEqual({
			providerId: "other",
			modelId: "qwen-coder",
			baseUrl: "http://127.0.0.1:8181/v1",
		});
	});

	it("fails closed to unknown endpoint without any Pi provider configuration", async () => {
		await makeAgentDir();
		expect(await resolvePiTurnTarget()).toEqual({
			providerId: "pi",
			modelId: null,
			baseUrl: null,
		});
	});
});
