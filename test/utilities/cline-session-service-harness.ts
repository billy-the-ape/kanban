// Shared harness for driving the real InMemoryClineTaskSessionService through
// the real InMemoryClineSessionRuntime against the in-memory fake session
// host (test/utilities/fake-cline-session-host.ts).
//
// Test files using this harness should still mock the turn-checkpoint module
// (src/workspace/turn-checkpoints.js) with vi.mock to keep checkpoint capture
// off the real git binary.

import type { ToolApprovalRequest, ToolApprovalResult } from "@clinebot/core";
import type { ClineMcpRuntimeService } from "../../src/cline-sdk/cline-mcp-runtime-service";
import type { ClineRuntimeSetup } from "../../src/cline-sdk/cline-runtime-setup";
import { createInMemoryClineSessionRuntime } from "../../src/cline-sdk/cline-session-runtime";
import type { ClineTaskSessionService } from "../../src/cline-sdk/cline-task-session-service";
import { createInMemoryClineTaskSessionService } from "../../src/cline-sdk/cline-task-session-service";
import {
	type CreateFakeClineSessionStoreOptions,
	createFakeClineSessionHost,
	createFakeClineSessionStore,
	type FakeClineSessionHost,
	type FakeClineSessionStore,
} from "./fake-cline-session-host";

export function createFakeRuntimeSetup(): ClineRuntimeSetup {
	return {
		userInstructionService: {
			start: async () => {},
			stop: () => {},
			refreshType: async () => {},
			listRecords: () => [],
			listRuntimeCommands: () => [],
			resolveRuntimeSlashCommand: (prompt: string) => prompt,
			hasConfiguredSkills: () => false,
			createExtension: () => ({
				name: "test-user-instructions",
				manifest: { capabilities: ["rules"] },
			}),
		} as unknown as ClineRuntimeSetup["userInstructionService"],
		resolvePrompt: (prompt: string) => prompt,
		loadRules: () => "test rules",
		requestToolApproval: async (_request: ToolApprovalRequest): Promise<ToolApprovalResult> => ({
			approved: true,
			reason: "approved in test",
		}),
		dispose: async () => {},
	};
}

export function createFakeMcpRuntimeService(): ClineMcpRuntimeService {
	return {
		createToolBundle: async () => ({
			tools: [],
			warnings: [],
			dispose: async () => {},
		}),
		getAuthStatuses: async () => [],
		authorizeServer: async () => {
			throw new Error("MCP authorization is not supported in the test harness.");
		},
	};
}

export interface CreateTaskSessionServiceHarnessOptions extends CreateFakeClineSessionStoreOptions {
	/**
	 * Share a store across harnesses to simulate two Kanban service processes
	 * reading the same persisted session data (service restart, B-1.7).
	 */
	store?: FakeClineSessionStore;
}

export interface TaskSessionServiceHarness {
	service: ClineTaskSessionService;
	host: FakeClineSessionHost;
	store: FakeClineSessionStore;
}

export function createTaskSessionServiceHarness(
	options: CreateTaskSessionServiceHarnessOptions = {},
): TaskSessionServiceHarness {
	const store = options.store ?? createFakeClineSessionStore(options);
	const host = createFakeClineSessionHost(store);
	const setup = createFakeRuntimeSetup();
	const service = createInMemoryClineTaskSessionService({
		createSessionRuntime: (runtimeOptions) =>
			createInMemoryClineSessionRuntime({
				...runtimeOptions,
				createSessionHost: async () => host,
				createMcpRuntimeService: () => createFakeMcpRuntimeService(),
			}),
		createRuntimeSetup: async () => setup,
	});
	return { service, host, store };
}
