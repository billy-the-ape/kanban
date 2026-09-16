// B-1.4 — Verification that the fake OpenAI-compatible provider fixture
// behaves deterministically (model catalog, scripted completions, exact
// context-overflow error shapes, streaming, auth).

import { afterEach, describe, expect, it } from "vitest";
import { createFakeOpenAiProvider, type FakeOpenAiProvider } from "../utilities/fake-openai-provider";

const providers: FakeOpenAiProvider[] = [];

async function withProvider<T>(
	provider: FakeOpenAiProvider,
	run: (provider: FakeOpenAiProvider) => Promise<T>,
): Promise<T> {
	providers.push(provider);
	await provider.start();
	try {
		return await run(provider);
	} finally {
		providers.splice(providers.indexOf(provider), 1);
	}
}

afterEach(async () => {
	await Promise.allSettled(providers.splice(0).map((provider) => provider.stop()));
});

describe("fake OpenAI-compatible provider (B-1.4)", () => {
	it("serves the model catalog and scripted completions", async () => {
		const provider = createFakeOpenAiProvider({ modelId: "llama-3.1-8b-instruct" });
		await withProvider(provider, async (p) => {
			const models = (await (await fetch(`${p.baseUrl}/models`)).json()) as {
				data: Array<{ id: string }>;
			};
			expect(models.data.map((model) => model.id)).toEqual(["llama-3.1-8b-instruct"]);

			const completion = (await (
				await fetch(`${p.baseUrl}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: "llama-3.1-8b-instruct",
						messages: [
							{ role: "user", content: "hello" },
							{ role: "assistant", content: "hi there" },
							{ role: "user", content: "second" },
						],
					}),
				})
			).json()) as {
				choices: Array<{ message: { content: string } }>;
			};

			expect(completion.choices[0]?.message.content).toBe("ok (3 messages)");
			expect(provider.requests).toHaveLength(1);
			expect(provider.requests[0]).toMatchObject({
				messageCount: 3,
				lastMessage: "second",
				exceededContextLimit: false,
			});
		});
	});

	it("rejects oversized requests with the exact llama.cpp error shape (upstream #504)", async () => {
		const provider = createFakeOpenAiProvider({
			contextLimitTokens: 3,
			// 1 token per message for a precise boundary.
			countTokens: (body) => (body.messages ?? []).length,
		});
		await withProvider(provider, async (p) => {
			const response = await fetch(`${p.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "fake-local-model",
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: "b" },
						{ role: "user", content: "c" },
						{ role: "assistant", content: "d" },
						{ role: "user", content: "e" },
					],
				}),
			});

			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: string };
			expect(payload.error).toBe(
				"request (5 tokens) exceeds the available context size (3 tokens), try increasing it",
			);
			expect(provider.requests[0]?.exceededContextLimit).toBe(true);
		});
	});

	it("rejects oversized requests with the OpenAI error shape when configured", async () => {
		const provider = createFakeOpenAiProvider({
			contextLimitTokens: 4,
			errorShape: "openai",
			countTokens: (body) => (body.messages ?? []).length,
		});
		await withProvider(provider, async (p) => {
			const response = await fetch(`${p.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "fake-local-model",
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: "b" },
						{ role: "user", content: "c" },
						{ role: "assistant", content: "d" },
						{ role: "user", content: "e" },
					],
				}),
			});

			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: { message: string; code: string } };
			expect(payload.error.code).toBe("context_length_exceeded");
			expect(payload.error.message).toContain("maximum context length is 4 tokens");
		});
	});

	it("streams SSE chunks when the request asks for streaming", async () => {
		const provider = createFakeOpenAiProvider();
		await withProvider(provider, async (p) => {
			const response = await fetch(`${p.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "fake-local-model",
					stream: true,
					messages: [{ role: "user", content: "stream me" }],
				}),
			});

			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain('"content":"ok (1 messages)"');
			expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
		});
	});

	it("enforces the API key when configured", async () => {
		const provider = createFakeOpenAiProvider({ apiKey: "secret-key" });
		await withProvider(provider, async (p) => {
			const rejected = await fetch(`${p.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer wrong" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
			});
			expect(rejected.status).toBe(401);

			const accepted = await fetch(`${p.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer secret-key" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
			});
			expect(accepted.status).toBe(200);
		});
	});
});
