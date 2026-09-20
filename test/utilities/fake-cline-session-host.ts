// Deterministic in-memory fake of the Cline SDK session-host boundary consumed
// by InMemoryClineSessionRuntime (src/cline-sdk/cline-session-runtime.ts).
//
// The store simulates the SDK's on-disk session persistence: multiple hosts
// created from the same store behave like separate Kanban service processes
// that read the same session data directory after a service restart (B-1.7).
//
// The fake never spawns processes and never touches the network, so unit
// suites can drive the real InMemoryClineTaskSessionService through the real
// InMemoryClineSessionRuntime without booting the SDK host.

import type {
	ClineSdkPersistedMessage,
	ClineSdkSessionRecord,
	ClineSdkStartSessionInput,
} from "../../src/cline-sdk/sdk-runtime-boundary";

/** SDK-provided start input; the fake consumes exactly this shape. */
export type FakeClineSessionStartInput = ClineSdkStartSessionInput;
/** Session config carried in the SDK start input. */
export type FakeClineSessionStartConfig = ClineSdkStartSessionInput["config"];

export interface FakeClineSessionSendInput {
	sessionId: string;
	prompt: string;
	userImages?: string[];
	userFiles?: string[];
	delivery?: "queue" | "steer";
	timeoutMs?: number;
}

export interface FakeClineSessionTurnContext {
	sessionId: string;
	prompt: string;
	/** 1-based count of turns sent through this store. */
	turnCount: number;
	store: FakeClineSessionStore;
}

export type FakeClineSessionTurnHandler = (
	context: FakeClineSessionTurnContext,
) => string | Promise<string> | undefined | null;

export interface FakeClineSessionStore {
	readonly records: Map<string, ClineSdkSessionRecord>;
	readonly messages: Map<string, ClineSdkPersistedMessage[]>;
	/** Called for every turn, after the user message is persisted. Throw to simulate provider failures. */
	onTurn?: FakeClineSessionTurnHandler;
	/** Default assistant reply when onTurn returns nothing. */
	assistantText?: (context: FakeClineSessionTurnContext) => string;
	record(sessionId: string): ClineSdkSessionRecord | undefined;
	messagesFor(sessionId: string): ClineSdkPersistedMessage[];
	/** Returns the next 1-based turn number; shared across hosts bound to this store. */
	nextTurnCount(): number;
}

export interface CreateFakeClineSessionStoreOptions {
	/**
	 * Called for every turn delivered through `send`, after the user message is
	 * persisted. Throw to simulate a provider failure (e.g. context overflow).
	 * Return a string to override the assistant reply for that turn.
	 */
	onTurn?: FakeClineSessionTurnHandler;
	/** Default assistant reply when onTurn returns nothing. */
	assistantText?: (context: FakeClineSessionTurnContext) => string;
}

export interface FakeClineSessionHost {
	start(input: FakeClineSessionStartInput): Promise<{ sessionId: string; result?: unknown }>;
	send(input: FakeClineSessionSendInput): Promise<unknown>;
	stop(sessionId: string): Promise<void>;
	abort(sessionId: string): Promise<void>;
	delete(sessionId: string): Promise<boolean>;
	dispose(reason?: string): Promise<void>;
	get(sessionId: string): Promise<ClineSdkSessionRecord | undefined>;
	list(limit?: number): Promise<ClineSdkSessionRecord[]>;
	update(
		sessionId: string,
		updates: {
			prompt?: string | null;
			metadata?: Record<string, unknown> | null;
			title?: string | null;
		},
	): Promise<{ updated: boolean }>;
	readMessages(sessionId: string): Promise<ClineSdkPersistedMessage[]>;
	subscribe(listener: (event: unknown) => void): () => void;

	/** Test inspection: every start() input in order. */
	readonly startedConfigs: FakeClineSessionStartConfig[];
	/** Test inspection: every send() input in order. */
	readonly sentPrompts: FakeClineSessionSendInput[];
	/** Emit a raw session event (SDK shape, e.g. { type: "ended", payload: { sessionId, reason } }). */
	emitEvent(event: unknown): void;
}
export function createFakeClineSessionStore(options: CreateFakeClineSessionStoreOptions = {}): FakeClineSessionStore {
	const records = new Map<string, ClineSdkSessionRecord>();
	const messages = new Map<string, ClineSdkPersistedMessage[]>();
	let turnCount = 0;

	const store: FakeClineSessionStore = {
		records,
		messages,
		onTurn: options.onTurn,
		assistantText: options.assistantText,
		record: (sessionId) => records.get(sessionId),
		messagesFor: (sessionId) => messages.get(sessionId) ?? [],
		nextTurnCount: () => {
			turnCount += 1;
			return turnCount;
		},
	};

	return store;
}

function buildRecord(
	config: FakeClineSessionStartConfig,
	sessionId: string,
	previous: ClineSdkSessionRecord | undefined,
): ClineSdkSessionRecord {
	const now = new Date().toISOString();
	return {
		...(previous ?? {}),
		sessionId,
		isSubagent: previous?.isSubagent ?? false,
		source: "core" as ClineSdkSessionRecord["source"],
		status: "running" as ClineSdkSessionRecord["status"],
		endedAt: null,
		exitCode: null,
		startedAt: previous?.startedAt ?? now,
		interactive: true,
		provider: config.providerId ?? "",
		model: config.modelId ?? "",
		cwd: config.cwd ?? "",
		workspaceRoot: previous?.workspaceRoot ?? config.cwd ?? "",
		enableTools: true,
		enableSpawn: false,
		enableTeams: false,
		prompt: previous?.prompt ?? "",
		metadata: previous?.metadata ?? {},
		updatedAt: now,
	};
}

export function createFakeClineSessionHost(store: FakeClineSessionStore): FakeClineSessionHost {
	const listeners = new Set<(event: unknown) => void>();
	const startedConfigs: FakeClineSessionStartConfig[] = [];
	const sentPrompts: FakeClineSessionSendInput[] = [];

	const host: FakeClineSessionHost = {
		async start(input: FakeClineSessionStartInput) {
			const config = input.config;
			if (!config.sessionId) {
				throw new Error("Fake session host requires config.sessionId.");
			}
			startedConfigs.push(config);
			const sessionId = config.sessionId;
			store.records.set(sessionId, buildRecord(config, sessionId, store.records.get(sessionId)));
			store.messages.set(
				sessionId,
				(input.initialMessages ?? []).map((message) => ({ ...message })),
			);
			return { sessionId };
		},

		async send(input: FakeClineSessionSendInput) {
			sentPrompts.push(input);
			const record = store.records.get(input.sessionId);
			if (!record) {
				throw new Error(`Fake session host has no session ${input.sessionId}.`);
			}
			const sessionMessages = store.messages.get(input.sessionId) ?? [];
			sessionMessages.push({ role: "user", content: input.prompt, sessionId: input.sessionId });
			store.messages.set(input.sessionId, sessionMessages);
			record.updatedAt = new Date().toISOString();

			const turnCount = store.nextTurnCount();
			const context: FakeClineSessionTurnContext = {
				sessionId: input.sessionId,
				prompt: input.prompt,
				turnCount,
				store,
			};
			let reply: string | null = null;
			if (store.onTurn) {
				const handled = await store.onTurn(context);
				reply = handled === undefined ? null : handled;
			}
			if (reply === null || reply === undefined) {
				reply = store.assistantText ? store.assistantText(context) : `ok (${turnCount}): ${input.prompt}`;
			}
			sessionMessages.push({ role: "assistant", content: reply, sessionId: input.sessionId });
			return { text: reply };
		},

		async stop(sessionId: string) {
			const record = store.records.get(sessionId);
			if (!record) {
				return;
			}
			record.status = "completed" as ClineSdkSessionRecord["status"];
			record.endedAt = new Date().toISOString();
		},

		async abort(sessionId: string) {
			await host.stop(sessionId);
		},

		async delete(sessionId: string) {
			const hadRecord = store.records.delete(sessionId);
			store.messages.delete(sessionId);
			return hadRecord;
		},

		async dispose() {
			// Persistence outlives the host on purpose: a second host bound to
			// the same store simulates a restarted Kanban service process.
		},

		async get(sessionId: string) {
			return store.records.get(sessionId);
		},

		async list(limit?: number) {
			const all = [...store.records.values()].sort((left, right) =>
				(left.updatedAt || "").localeCompare(right.updatedAt || ""),
			);
			return limit ? all.slice(-limit) : all;
		},

		async update(sessionId: string, updates) {
			const record = store.records.get(sessionId);
			if (!record) {
				return { updated: false };
			}
			if (updates.title !== undefined) {
				record.metadata = { ...record.metadata, title: updates.title ?? undefined };
			}
			if (updates.prompt !== undefined) {
				record.prompt = updates.prompt ?? undefined;
			}
			if (updates.metadata !== undefined) {
				record.metadata = updates.metadata ?? undefined;
			}
			record.updatedAt = new Date().toISOString();
			return { updated: true };
		},

		async readMessages(sessionId: string) {
			return store.messagesFor(sessionId).map((message) => ({ ...message }));
		},

		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		startedConfigs,
		sentPrompts,

		emitEvent(event: unknown) {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
	};

	return host;
}
