import { describe, expect, it } from "vitest";
import { CLINE_EDITOR_SIZE_GUIDANCE, resolveClineSdkSystemPrompt } from "../../../src/cline-sdk/sdk-runtime-boundary";

describe("Cline editor size guidance", () => {
	it("describes the local adapter's relaxed limit and fresh-anchor recovery", async () => {
		expect(CLINE_EDITOR_SIZE_GUIDANCE).toContain("under 30000 characters");
		expect(CLINE_EDITOR_SIZE_GUIDANCE).toContain("hard limit is 32000");
		expect(CLINE_EDITOR_SIZE_GUIDANCE).toContain("read the current file section");
		const prompt = await resolveClineSdkSystemPrompt({ cwd: process.cwd(), providerId: "openai" });
		expect(prompt).toContain(CLINE_EDITOR_SIZE_GUIDANCE);
	});
});
