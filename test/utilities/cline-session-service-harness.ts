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
import {
	type ClineLaunchConfigResolver,
	createInMemoryClineSessionRuntime,
} from "../../src/cline-sdk/cline-session-runtime";
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
	/**
	 * B-2.8: launch-config resolver forwarded to the session runtime so
	 * restarts re-resolve the policy instead of replaying the snapshot.
	 */
	resolveClineLaunchConfig?: ClineLaunchConfigResolver;
	/**
	 * B-3.5: bounded context-overflow recovery attempt cap forwarded to the
	 * task session service (the service default is 3 when omitted).
	 */
	contextRecoveryMaxAttempts?: number;
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
		contextRecoveryMaxAttempts: options.contextRecoveryMaxAttempts,
		resolveClineLaunchConfig: options.resolveClineLaunchConfig,
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
