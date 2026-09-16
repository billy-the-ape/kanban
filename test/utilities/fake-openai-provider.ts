// B-1.4 — Deterministic OpenAI-compatible provider for local reproduction.
//
// A tiny in-process HTTP server that speaks just enough of the OpenAI chat
// completions API for a real Kanban/SDK client to run against it without any
// real model endpoint:
//
// - GET  /v1/models           -> model catalog
// - POST /v1/chat/completions -> scripted replies, streaming or not
//
// `contextLimitTokens` makes overflow deterministic: when the estimated token
// count of a request exceeds the limit the server rejects it with the exact
// error shape of a real backend (llama.cpp by default, OpenAI optional).
// Token counting is a configurable estimate (characters / 4 by default) so
// tests control the overflow boundary precisely.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeOpenAiErrorShape = "llama.cpp" | "openai";

export interface FakeOpenAiProviderRequest {
	model: string;
	tokenCount: number;
	messageCount: number;
	/** Last message text in the request, for assertions. */
	lastMessage: string | null;
	exceededContextLimit: boolean;
}

export interface FakeOpenAiProviderOptions {
	/** Model id advertised by /v1/models and echoed in completions. */
	modelId?: string;
	/** Reject requests whose estimated token count exceeds this limit. */
	contextLimitTokens?: number;
	/** Error payload shape used when the context limit is exceeded. */
	errorShape?: FakeOpenAiErrorShape;
	/**
	 * Estimate the token count of a chat completion request body. Default:
	 * sum of message content lengths / 4. Deterministic per body.
	 */
	countTokens?: (body: { messages?: unknown[]; model?: string }) => number;
	/** Produce the assistant reply for an accepted request. */
	respondWith?: (request: FakeOpenAiProviderRequest) => string;
	/** When set, requests with a different Bearer token get a 401. */
	apiKey?: string;
}

export interface FakeOpenAiProvider {
	/** http://127.0.0.1:<port>/v1 (valid after start()). */
	baseUrl: string;
	port: number;
	/** Every chat completion request in order (accepted and rejected). */
	requests: FakeOpenAiProviderRequest[];
	start(): Promise<void>;
	stop(): Promise<void>;
}

function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block && typeof block === "object" && "text" in block) {
					return String((block as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join(" ");
	}
	return "";
}

function defaultCountTokens(body: { messages?: unknown[]; model?: string }): number {
	let total = 0;
	for (const message of body.messages ?? []) {
		total += messageText((message as { content?: unknown } | null)?.content ?? "").length;
	}
	return Math.ceil(total / 4);
}

function buildContextLimitError(shape: FakeOpenAiErrorShape, tokenCount: number, limit: number): unknown {
	if (shape === "openai") {
		return {
			error: {
				message: `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${tokenCount} tokens. Please shorten the messages or completion.`,
				type: "invalid_request_error",
				code: "context_length_exceeded",
			},
		};
	}
	// Exact string shape reported in upstream cline/kanban issue #504.
	return {
		error: `request (${tokenCount} tokens) exceeds the available context size (${limit} tokens), try increasing it`,
	};
}
export function createFakeOpenAiProvider(options: FakeOpenAiProviderOptions = {}): FakeOpenAiProvider {
	const modelId = options.modelId ?? "fake-local-model";
	const errorShape: FakeOpenAiErrorShape = options.errorShape ?? "llama.cpp";
	const countTokens = options.countTokens ?? defaultCountTokens;
	const requests: FakeOpenAiProviderRequest[] = [];
	let server: Server | null = null;
	let port = 0;

	function sendJson(res: ServerResponse, status: number, payload: unknown): void {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	}

	function handleModels(res: ServerResponse): void {
		sendJson(res, 200, {
			object: "list",
			data: [{ id: modelId, object: "model", owned_by: "kanban-test" }],
		});
	}

	function handleCompletions(req: IncomingMessage, res: ServerResponse): void {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			let body: { messages?: unknown[]; model?: string; stream?: boolean };
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
				return;
			}
			const providerRequest: FakeOpenAiProviderRequest = {
				model: body.model ?? modelId,
				tokenCount: countTokens(body),
				messageCount: (body.messages ?? []).length,
				lastMessage:
					messageText(((body.messages ?? []).at(-1) as { content?: unknown } | undefined)?.content ?? "") || null,
				exceededContextLimit: false,
			};
			requests.push(providerRequest);

			if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
				sendJson(res, 401, {
					error: { message: "Invalid API key", type: "invalid_request_error" },
				});
				return;
			}
			if (options.contextLimitTokens !== undefined && providerRequest.tokenCount > options.contextLimitTokens) {
				providerRequest.exceededContextLimit = true;
				sendJson(
					res,
					400,
					buildContextLimitError(errorShape, providerRequest.tokenCount, options.contextLimitTokens),
				);
				return;
			}

			const content = options.respondWith
				? options.respondWith(providerRequest)
				: `ok (${providerRequest.messageCount} messages)`;
			if (body.stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = {
					id: "chatcmpl-fake",
					object: "chat.completion.chunk",
					model: providerRequest.model,
					choices: [{ index: 0, delta: { content }, finish_reason: null }],
				};
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}
			sendJson(res, 200, {
				id: "chatcmpl-fake",
				object: "chat.completion",
				model: providerRequest.model,
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: providerRequest.tokenCount,
					completion_tokens: Math.ceil(content.length / 4),
					total_tokens: providerRequest.tokenCount + Math.ceil(content.length / 4),
				},
			});
		});
	}

	const provider: FakeOpenAiProvider = {
		baseUrl: "",
		port: 0,
		requests,

		async start() {
			server = createServer((req, res) => {
				const url = (req.url ?? "").split("?")[0];
				if (req.method === "GET" && url === "/v1/models") {
					handleModels(res);
					return;
				}
				if (req.method === "POST" && url === "/v1/chat/completions") {
					handleCompletions(req, res);
					return;
				}
				sendJson(res, 404, { error: { message: `no route ${url}`, type: "invalid_request_error" } });
			});
			await new Promise<void>((resolve) => {
				server?.listen(0, "127.0.0.1", resolve);
			});
			port = (server?.address() as AddressInfo).port;
			provider.baseUrl = `http://127.0.0.1:${port}/v1`;
			provider.port = port;
		},

		async stop() {
			const active = server;
			server = null;
			if (!active) {
				return;
			}
			await new Promise<void>((resolve) => {
				active.close(() => resolve());
			});
		},
	};

	return provider;
}
