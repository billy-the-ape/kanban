import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClineProviderService } from "../../../src/cline-sdk/cline-provider-service";
import {
	runtimeClineProviderModelSchema,
	runtimeClineProviderModelsResponseSchema,
} from "../../../src/core/api-contract";

const oauthMocks = vi.hoisted(() => ({
	saveProviderSettings: vi.fn(),
	getProviderSettings: vi.fn(),
	getLastUsedProviderSettings: vi.fn(),
}));

const llmsModelMocks = vi.hoisted(() => ({
	resolveProviderConfig: vi.fn(),
	resolveProviderModelCatalogKeys: vi.fn(),
}));

const localProviderMocks = vi.hoisted(() => ({
	getLocalProviderModels: vi.fn(),
}));

const runtimeConfigMocks = vi.hoisted(() => ({
	readGlobalRuntimeContextBudget: vi.fn(),
}));

// B-2.9: resolveLaunchConfig reads the global context budget from the
// runtime config; keep the test hermetic (no real HOME reads).
vi.mock("../../../src/config/runtime-config", () => ({
	readGlobalRuntimeContextBudget: runtimeConfigMocks.readGlobalRuntimeContextBudget,
}));

vi.mock("@clinebot/core", () => ({
	addLocalProvider: vi.fn(),
	completeClineDeviceAuth: vi.fn(),
	ensureCustomProvidersLoaded: vi.fn(),
	getLocalProviderModels: localProviderMocks.getLocalProviderModels,
	getValidClineCredentials: vi.fn(),
	getValidOcaCredentials: vi.fn(),
	getValidOpenAICodexCredentials: vi.fn(),
	InMemoryMcpManager: class {},
	loadMcpSettingsFile: vi.fn(),
	loginClineOAuth: vi.fn(),
	loginOcaOAuth: vi.fn(),
	loginOpenAICodex: vi.fn(),
	resolveClineDataDir: vi.fn(() => "/tmp/cline"),
	createMcpTools: vi.fn(async () => []),
	startClineDeviceAuth: vi.fn(),
	DEFAULT_EXTERNAL_IDCS_CLIENT_ID: "",
	DEFAULT_EXTERNAL_IDCS_SCOPES: "",
	DEFAULT_EXTERNAL_IDCS_URL: "",
	DEFAULT_INTERNAL_IDCS_CLIENT_ID: "",
	DEFAULT_INTERNAL_IDCS_SCOPES: "",
	DEFAULT_INTERNAL_IDCS_URL: "",
	ClineAccountService: class {
		fetchMe = vi.fn();
		fetchRemoteConfig = vi.fn();
		fetchOrganization = vi.fn();
		fetchFeaturebaseToken = vi.fn();
		fetchBalance = vi.fn();
		fetchOrganizationBalance = vi.fn();
		switchAccount = vi.fn();
	},
	ProviderSettingsManager: class {
		saveProviderSettings = oauthMocks.saveProviderSettings;
		getProviderSettings = oauthMocks.getProviderSettings;
		getLastUsedProviderSettings = oauthMocks.getLastUsedProviderSettings;
		getProviderConfig = vi.fn((providerId: string) => {
			const settings = oauthMocks.getProviderSettings(providerId);
			if (!settings) {
				return undefined;
			}
			return {
				providerId: settings.provider,
				apiKey: settings.apiKey,
				modelId: settings.model,
				baseUrl: settings.baseUrl,
			};
		});
		getFilePath = vi.fn(() => "/tmp/provider-settings.json");
		read = vi.fn(() => ({ providers: {} }));
		write = vi.fn();
	},
	Llms: {
		getAllProviders: vi.fn(async () => []),
		resolveProviderModelCatalogKeys: llmsModelMocks.resolveProviderModelCatalogKeys,
	},
	resolveProviderConfig: llmsModelMocks.resolveProviderConfig,
}));

vi.mock("../../../src/server/browser", () => ({
	openInBrowser: vi.fn(),
}));

function setProviderSettings(
	settings: {
		provider: string;
		model?: string;
		apiKey?: string;
		baseUrl?: string;
	} | null,
): void {
	oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
		settings && settings.provider === providerId ? settings : undefined,
	);
}

function stubLiteLlmFetch(responses: Record<string, { status?: number; json?: unknown }>): void {
	const fetchMock = vi.fn(async (input: unknown) => {
		const url = String(input);
		const entry = Object.entries(responses).find(([pathname]) => url.endsWith(pathname));
		if (!entry) {
			throw new Error(`Unexpected fetch URL in test: ${url}`);
		}
		const { status = 200, json = {} } = entry[1];
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => json,
		} as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
}

describe("runtimeClineProviderModelSchema contextWindow", () => {
	it("accepts a positive integer contextWindow and preserves it through validation", () => {
		const parsed = runtimeClineProviderModelSchema.parse({ id: "model-1", name: "Model 1", contextWindow: 131072 });
		expect(parsed.contextWindow).toBe(131072);
	});

	it("accepts null as explicitly unknown and preserves it through validation", () => {
		const parsed = runtimeClineProviderModelSchema.parse({ id: "model-1", name: "Model 1", contextWindow: null });
		expect(parsed.contextWindow).toBe(null);
	});

	it("accepts an absent contextWindow", () => {
		const parsed = runtimeClineProviderModelSchema.parse({ id: "model-1", name: "Model 1" });
		expect(parsed).not.toHaveProperty("contextWindow");
	});

	it.each([0, -5, 12.5, "131072"] as const)("rejects an invalid contextWindow value (%s)", (value) => {
		expect(
			runtimeClineProviderModelSchema.safeParse({ id: "model-1", name: "Model 1", contextWindow: value }).success,
		).toBe(false);
	});

	describe("ClineProviderService context capacity", () => {
		beforeEach(() => {
			oauthMocks.getProviderSettings.mockReset();
			oauthMocks.getLastUsedProviderSettings.mockReset();
			localProviderMocks.getLocalProviderModels.mockReset();
			llmsModelMocks.resolveProviderConfig.mockReset();
			llmsModelMocks.resolveProviderModelCatalogKeys.mockReset();
			runtimeConfigMocks.readGlobalRuntimeContextBudget.mockReset();
			localProviderMocks.getLocalProviderModels.mockResolvedValue({ providerId: "", models: [] });
			llmsModelMocks.resolveProviderConfig.mockResolvedValue(undefined);
			llmsModelMocks.resolveProviderModelCatalogKeys.mockImplementation((providerId: string) => [providerId]);
			oauthMocks.getLastUsedProviderSettings.mockReturnValue(undefined);
			runtimeConfigMocks.readGlobalRuntimeContextBudget.mockResolvedValue(undefined);
			setProviderSettings(null);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("maps LiteLLM /model/info max_input_tokens to contextWindow", async () => {
			const service = createClineProviderService();
			setProviderSettings({ provider: "litellm", model: "qwen3-32b", baseUrl: "http://127.0.0.1:4000" });
			stubLiteLlmFetch({
				"/models": { status: 404 },
				"/model/info": {
					json: {
						data: [
							{ model_name: "qwen3-32b", id: "qwen3-32b", max_input_tokens: 131072 },
							{ model_name: "llama3-70b", id: "llama3-70b" },
						],
					},
				},
			});

			const response = await service.getProviderModels("litellm");

			expect(response.providerId).toBe("litellm");
			expect(response.models).toEqual([
				{ id: "llama3-70b", name: "llama3-70b" },
				{ id: "qwen3-32b", name: "qwen3-32b", contextWindow: 131072 },
			]);
			// The tRPC .output() contract must preserve the field, not strip it.
			const validated = runtimeClineProviderModelsResponseSchema.parse(response);
			expect(validated.models.find((model) => model.id === "qwen3-32b")?.contextWindow).toBe(131072);
		});

		it("leaves contextWindow absent when only the /models route responds", async () => {
			const service = createClineProviderService();
			setProviderSettings({ provider: "litellm", model: "qwen3-32b", baseUrl: "http://127.0.0.1:4000" });
			stubLiteLlmFetch({
				"/models": {
					json: { data: [{ id: "qwen3-32b" }] },
				},
			});

			const response = await service.getProviderModels("litellm");

			expect(response.models).toEqual([{ id: "qwen3-32b", name: "qwen3-32b" }]);
			expect(response.models[0]).not.toHaveProperty("contextWindow");
		});

		it("does not trust max_input_tokens reported by the /models route", async () => {
			const service = createClineProviderService();
			setProviderSettings({ provider: "litellm", model: "qwen3-32b", baseUrl: "http://127.0.0.1:4000" });
			stubLiteLlmFetch({
				"/models": {
					json: { data: [{ id: "qwen3-32b", max_input_tokens: 999 }] },
				},
			});

			const response = await service.getProviderModels("litellm");

			expect(response.models).toEqual([{ id: "qwen3-32b", name: "qwen3-32b" }]);
			expect(response.models[0]).not.toHaveProperty("contextWindow");
		});

		it("ignores invalid max_input_tokens from /model/info instead of reporting unlimited", async () => {
			const service = createClineProviderService();
			setProviderSettings({ provider: "litellm", model: "qwen3-32b", baseUrl: "http://127.0.0.1:4000" });
			stubLiteLlmFetch({
				"/model/info": {
					json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 0 }] },
				},
			});

			const response = await service.getProviderModels("litellm");

			expect(response.models).toEqual([{ id: "qwen3-32b", name: "qwen3-32b" }]);
			expect(response.models[0]).not.toHaveProperty("contextWindow");
		});

		it("maps SDK catalog contextWindow through listSdkProviderModels", async () => {
			const service = createClineProviderService();
			setProviderSettings({ provider: "deepseek", model: "deepseek-chat", apiKey: "key-1" });
			localProviderMocks.getLocalProviderModels.mockResolvedValue({
				providerId: "deepseek",
				models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
			});
			llmsModelMocks.resolveProviderConfig.mockResolvedValue({
				knownModels: {
					"deepseek-v4-pro": {
						id: "deepseek-v4-pro",
						name: "DeepSeek V4 Pro",
						contextWindow: 131072,
						capabilities: ["tools"],
					},
				},
			});

			const response = await service.getProviderModels("deepseek");

			expect(response.models).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "deepseek-chat", name: "DeepSeek Chat" }),
					expect.objectContaining({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 131072 }),
				]),
			);
			const validated = runtimeClineProviderModelsResponseSchema.parse(response);
			expect(validated.models.find((model) => model.id === "deepseek-v4-pro")?.contextWindow).toBe(131072);
		});

		it("leaves the fallback single-model entry without contextWindow", async () => {
			const service = createClineProviderService();
			setProviderSettings({ provider: "openrouter", model: "openrouter/auto" });
			localProviderMocks.getLocalProviderModels.mockResolvedValue({
				providerId: "openrouter",
				models: [],
			});

			const response = await service.getProviderModels("openrouter");

			expect(response.models).toEqual([{ id: "openrouter/auto", name: "openrouter/auto" }]);
			expect(response.models[0]).not.toHaveProperty("contextWindow");
		});

		describe("getProviderModelContextWindow (B-2.2)", () => {
			it("returns the LiteLLM /model/info reported capacity for a known model", async () => {
				const service = createClineProviderService();
				setProviderSettings({
					provider: "litellm",
					model: "qwen3-32b",
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
				});
				stubLiteLlmFetch({
					"/models": { status: 404 },
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 262144 }] },
					},
				});

				await expect(service.getProviderModelContextWindow("litellm", "qwen3-32b")).resolves.toBe(262144);
			});

			it("returns the SDK catalog capacity for a non-LiteLLM model", async () => {
				const service = createClineProviderService();
				setProviderSettings({ provider: "deepseek", model: "deepseek-chat", apiKey: "key-1" });
				localProviderMocks.getLocalProviderModels.mockResolvedValue({
					providerId: "deepseek",
					models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
				});
				llmsModelMocks.resolveProviderConfig.mockResolvedValue({
					knownModels: {
						"deepseek-v4-pro": {
							id: "deepseek-v4-pro",
							name: "DeepSeek V4 Pro",
							contextWindow: 131072,
						},
					},
				});

				await expect(service.getProviderModelContextWindow("deepseek", "deepseek-v4-pro")).resolves.toBe(131072);
			});

			it("returns null when the model is listed without a capacity", async () => {
				const service = createClineProviderService();
				setProviderSettings({
					provider: "litellm",
					model: "qwen3-32b",
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
				});
				stubLiteLlmFetch({
					"/model/info": { json: { data: [] } },
				});

				await expect(service.getProviderModelContextWindow("litellm", "qwen3-32b")).resolves.toBeNull();
			});

			it("returns null without throwing when the LiteLLM server is unreachable", async () => {
				const service = createClineProviderService();
				setProviderSettings({
					provider: "litellm",
					model: "qwen3-32b",
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
				});
				stubLiteLlmFetch({
					"/models": { status: 500 },
					"/model/info": { status: 500 },
				});

				await expect(service.getProviderModelContextWindow("litellm", "qwen3-32b")).resolves.toBeNull();
			});

			it("returns null for empty provider or model ids", async () => {
				const service = createClineProviderService();
				setProviderSettings({
					provider: "litellm",
					model: "qwen3-32b",
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
				});

				await expect(service.getProviderModelContextWindow("  ", "qwen3-32b")).resolves.toBeNull();
				await expect(service.getProviderModelContextWindow("litellm", null)).resolves.toBeNull();
			});

			it("caches lookups within the TTL instead of re-fetching", async () => {
				const service = createClineProviderService();
				setProviderSettings({
					provider: "litellm",
					model: "qwen3-32b",
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
				});
				const fetchMock = vi.fn(async (input: unknown) => {
					const url = String(input);
					if (url.endsWith("/model/info")) {
						return {
							ok: true,
							status: 200,
							json: async () => ({
								data: [{ model_name: "qwen3-32b", max_input_tokens: 262144 }],
							}),
						} as unknown as Response;
					}
					return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
				});
				vi.stubGlobal("fetch", fetchMock);

				const first = await service.getProviderModelContextWindow("litellm", "qwen3-32b");
				const fetchCountAfterFirst = fetchMock.mock.calls.length;
				const second = await service.getProviderModelContextWindow("litellm", "qwen3-32b");

				expect(first).toBe(262144);
				expect(second).toBe(262144);
				expect(fetchCountAfterFirst).toBeGreaterThan(0);
				expect(fetchMock.mock.calls.length).toBe(fetchCountAfterFirst);
			});
		});

		describe("resolveLaunchConfig context limit (B-2.2)", () => {
			function setLastUsedLitellmSettings(settings: { model: string; contextWindow?: number }): void {
				const providerSettings = {
					provider: "litellm",
					model: settings.model,
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
					...(settings.contextWindow !== undefined ? { contextWindow: settings.contextWindow } : {}),
				};
				setProviderSettings(providerSettings);
				oauthMocks.getLastUsedProviderSettings.mockReturnValue(providerSettings);
			}

			it("uses the persisted override when it is more restrictive than the metadata", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 128_000 });
				stubLiteLlmFetch({
					"/models": { status: 404 },
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 262144 }] },
					},
				});

				const config = await service.resolveLaunchConfig();

				expect(config.providerId).toBe("litellm");
				expect(config.modelId).toBe("qwen3-32b");
				expect(config.apiKey).toBe("litellm-key");
				expect(config.contextWindowTokens).toBe(128_000);
				expect(config.contextWindowSource).toBe("override");
			});

			it("uses the provider metadata when it is more restrictive than the override", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 200_000 });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131072 }] },
					},
				});

				const config = await service.resolveLaunchConfig();

				expect(config.contextWindowTokens).toBe(131072);
				expect(config.contextWindowSource).toBe("provider-metadata");
			});

			it("uses the provider metadata when no override is configured", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b" });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 262144 }] },
					},
				});

				const config = await service.resolveLaunchConfig();

				expect(config.contextWindowTokens).toBe(262144);
				expect(config.contextWindowSource).toBe("provider-metadata");
			});

			it("falls back to the conservative limit when no capacity is known", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "unknown-model" });
				stubLiteLlmFetch({
					"/model/info": { json: { data: [] } },
				});

				const config = await service.resolveLaunchConfig();

				expect(config.modelId).toBe("unknown-model");
				expect(config.contextWindowTokens).toBe(200_000);
				expect(config.contextWindowSource).toBe("fallback");
			});

			it("ignores an invalid persisted override and resolves from the metadata", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 0 });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131072 }] },
					},
				});

				const config = await service.resolveLaunchConfig();

				expect(config.contextWindowTokens).toBe(131072);
				expect(config.contextWindowSource).toBe("provider-metadata");
			});
		});

		describe("resolveLaunchConfig context budget (B-2.9 tier 0)", () => {
			function setLastUsedLitellmSettings(settings: { model: string; contextWindow?: number }): void {
				const providerSettings = {
					provider: "litellm",
					model: settings.model,
					apiKey: "litellm-key",
					baseUrl: "http://127.0.0.1:4000",
					...(settings.contextWindow !== undefined ? { contextWindow: settings.contextWindow } : {}),
				};
				setProviderSettings(providerSettings);
				oauthMocks.getLastUsedProviderSettings.mockReturnValue(providerSettings);
			}

			it("lets the global budget override win over every other tier", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b", contextWindow: 128_000 });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 262144 }] },
					},
				});
				runtimeConfigMocks.readGlobalRuntimeContextBudget.mockResolvedValue({
					contextWindowOverrideTokens: 64_000,
					compactionStrategy: "agentic",
					triggerThresholdRatio: 0.75,
					outputReserveTokens: 8_192,
					safetyMarginTokens: 6_000,
				});

				const config = await service.resolveLaunchConfig();

				// The user's explicit budget wins outright (tier 0), even when
				// the persisted provider-settings override is smaller.
				expect(config.contextWindowTokens).toBe(64_000);
				expect(config.contextWindowSource).toBe("override");
				expect(config.compactionSettings).toEqual({
					strategy: "agentic",
					thresholdRatio: 0.75,
					reserveTokens: 8_192,
					safetyMarginTokens: 6_000,
				});
			});

			it("carries the budget's compaction fields when no window override is set", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b" });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131072 }] },
					},
				});
				runtimeConfigMocks.readGlobalRuntimeContextBudget.mockResolvedValue({
					compactionStrategy: "agentic",
				});

				const config = await service.resolveLaunchConfig();

				expect(config.contextWindowTokens).toBe(131072);
				expect(config.contextWindowSource).toBe("provider-metadata");
				expect(config.compactionSettings).toEqual({ strategy: "agentic" });
			});

			it("carries no compaction settings when the budget is unset", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b" });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131072 }] },
					},
				});

				const config = await service.resolveLaunchConfig();

				expect(config.compactionSettings).toBeUndefined();
			});

			it("treats an invalid budget override as unset", async () => {
				const service = createClineProviderService();
				setLastUsedLitellmSettings({ model: "qwen3-32b" });
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131072 }] },
					},
				});
				runtimeConfigMocks.readGlobalRuntimeContextBudget.mockResolvedValue({
					// Impossible from a validated config; defense in depth.
					contextWindowOverrideTokens: -1,
				});

				const config = await service.resolveLaunchConfig();

				expect(config.contextWindowTokens).toBe(131072);
				expect(config.contextWindowSource).toBe("provider-metadata");
			});
		});

		describe("resolveEffectiveContextWindow (B-2.9)", () => {
			it("returns the budget override without needing a selected provider", async () => {
				const service = createClineProviderService();
				setProviderSettings(null);

				expect(await service.resolveEffectiveContextWindow(64_000)).toEqual({
					limitTokens: 64_000,
					source: "override",
				});
			});

			it("resolves provider settings and metadata for the selected provider", async () => {
				const service = createClineProviderService();
				setProviderSettings({
					provider: "litellm",
					model: "qwen3-32b",
					baseUrl: "http://127.0.0.1:4000",
					apiKey: "litellm-key",
				});
				oauthMocks.getLastUsedProviderSettings.mockReturnValue({
					provider: "litellm",
					model: "qwen3-32b",
					baseUrl: "http://127.0.0.1:4000",
					apiKey: "litellm-key",
				});
				stubLiteLlmFetch({
					"/model/info": {
						json: { data: [{ model_name: "qwen3-32b", max_input_tokens: 131072 }] },
					},
				});

				expect(await service.resolveEffectiveContextWindow(null)).toEqual({
					limitTokens: 131072,
					source: "provider-metadata",
				});
			});

			it("resolves the documented fallback when the selected provider has no known model capacity", async () => {
				const service = createClineProviderService();
				setProviderSettings(null);

				// No budget override and no explicitly selected provider: the
				// selection falls back to the SDK default provider with an
				// unknown model capacity, matching resolveLaunchConfig's
				// documented fallback.
				expect(await service.resolveEffectiveContextWindow(null)).toEqual({
					limitTokens: 200_000,
					source: "fallback",
				});
			});
		});
	});
});
