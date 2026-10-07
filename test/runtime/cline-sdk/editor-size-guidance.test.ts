import { describe, expect, it } from "vitest";
import { CLINE_EDITOR_SIZE_GUIDANCE, resolveClineSdkSystemPrompt } from "../../../src/cline-sdk/sdk-runtime-boundary";

describe("Cline editor size guidance", () => {
	it("tells the agent to keep editor calls under 5000 characters, below the SDK's 6000 hard limit", async () => {
		expect(CLINE_EDITOR_SIZE_GUIDANCE).toContain("under 5000 characters");
		expect(CLINE_EDITOR_SIZE_GUIDANCE).not.toContain("6000");
		const prompt = await resolveClineSdkSystemPrompt({ cwd: process.cwd(), providerId: "openai" });
		expect(prompt).toContain(CLINE_EDITOR_SIZE_GUIDANCE);
	});
});
