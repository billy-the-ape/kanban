import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../core/api-contract";
import { parseTerminalWsClientMessage } from "../core/api-validation";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { handleSocketUpgrade } from "../server/middleware";
import type { TerminalSessionService } from "./terminal-session-service";

interface TerminalWebSocketConnectionContext {
	taskId: string;
	workspaceId: string;
	clientId: string;
	terminalManager: TerminalSessionService;
}

interface UpgradeRequest extends IncomingMessage {
	__kanbanUpgradeHandled?: boolean;
}

export interface CreateTerminalWebSocketBridgeRequest {
	server: Server;
	resolveTerminalManager: (workspaceId: string) => TerminalSessionService | null;
	isTerminalIoWebSocketPath: (pathname: string) => boolean;
	isTerminalControlWebSocketPath: (pathname: string) => boolean;
	/**
	 * Optional session validator for remote-mode passcode enforcement.
	 * When provided, WebSocket upgrade requests that fail validation are
	 * rejected with HTTP 401 before the connection is established.
	 * @param cookieHeader - The value of the Cookie request header (may be undefined).
	 * @returns true if the request is authenticated, false otherwise.
	 */
	validateUpgradeSession?: (cookieHeader: string | undefined) => boolean;
}

export interface TerminalWebSocketBridge {
	close: () => Promise<void>;
}

interface IoOutputState {
	enqueueOutput: (chunk: Buffer) => void;
	acknowledgeOutput: (bytes: number) => void;
	dispose: () => void;
}

// One PTY session can have many browser viewers at the same time.
// Keep shared stream ownership at the task level, then isolate restore,
// buffering, and socket replacement per clientId so one tab cannot evict another.
interface TerminalViewerState {
	clientId: string;
	pendingOutputChunks: Buffer[];
	pendingOutputBytes: number;
	/** Disconnected for lagging behind; a new socket must restore its snapshot. */
	laggedOut: boolean;
	restoreComplete: boolean;
	ioState: IoOutputState | null;
	ioSocket: WebSocket | null;
	controlSocket: WebSocket | null;
	detachControlListener: (() => void) | null;
	flushPendingOutput: () => void;
}

interface TerminalStreamState {
	viewers: Map<string, TerminalViewerState>;
	// The agent PTY must never be paused by slow browser viewers.
	// Every viewer is bounded and can reattach to the server-side snapshot.
	detachOutputListener: (() => void) | null;
}

const OUTPUT_BATCH_INTERVAL_MS = 4;
const LOW_LATENCY_CHUNK_BYTES = 256;
const LOW_LATENCY_IDLE_WINDOW_MS = 5;
// Limits belong to each viewer. If exceeded, discard that viewer's socket;
// the UI reconnects and obtains a consistent server-side terminal snapshot.
const MAX_VIEWER_UNACKNOWLEDGED_BYTES = 512 * 1024;
const MAX_VIEWER_PENDING_RESTORE_BYTES = 512 * 1024;
const MAX_VIEWER_SOCKET_BUFFERED_BYTES = 2 * 1024 * 1024;

function rawDataToBuffer(message: RawData): Buffer {
	if (typeof message === "string") {
		return Buffer.from(message, "utf8");
	}
	if (Buffer.isBuffer(message)) {
		return message;
	}
	if (Array.isArray(message)) {
		return Buffer.concat(message.map((part) => rawDataToBuffer(part)));
	}
	return Buffer.from(message);
}

function parseWebSocketPayload(message: RawData) {
	try {
		const text = typeof message === "string" ? message : message.toString("utf8");
		const parsed = JSON.parse(text) as unknown;
		return parseTerminalWsClientMessage(parsed);
	} catch {
		return null;
	}
}

function sendControlMessage(ws: WebSocket, message: RuntimeTerminalWsServerMessage): void {
	if (ws.readyState !== ws.OPEN) {
		return;
	}
	ws.send(JSON.stringify(message));
}

function buildConnectionKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function getTerminalClientId(url: URL): string {
	return url.searchParams.get("clientId")?.trim() || "legacy";
}

export function createTerminalWebSocketBridge({
	server,
	resolveTerminalManager,
	isTerminalIoWebSocketPath,
	isTerminalControlWebSocketPath,
	validateUpgradeSession,
}: CreateTerminalWebSocketBridgeRequest): TerminalWebSocketBridge {
	const activeSockets = new Set<Socket>();
	const terminalStreamStates = new Map<string, TerminalStreamState>();
	server.on("connection", (socket: Socket) => {
		socket.setNoDelay(true);
		activeSockets.add(socket);
		socket.on("close", () => {
			activeSockets.delete(socket);
		});
	});

	const ioServer = new WebSocketServer({ noServer: true });
	const controlServer = new WebSocketServer({ noServer: true });

	const getOrCreateTerminalStreamState = (connectionKey: string): TerminalStreamState => {
		const existing = terminalStreamStates.get(connectionKey);
		if (existing) {
			return existing;
		}
		const created: TerminalStreamState = {
			viewers: new Map(),
			detachOutputListener: null,
		};
		terminalStreamStates.set(connectionKey, created);
		return created;
	};

	const cleanupTerminalStreamStateIfUnused = (connectionKey: string): void => {
		const state = terminalStreamStates.get(connectionKey);
		if (!state || state.viewers.size > 0) {
			return;
		}
		state.detachOutputListener?.();
		state.detachOutputListener = null;
		terminalStreamStates.delete(connectionKey);
	};

	const getOrCreateViewerState = (streamState: TerminalStreamState, clientId: string): TerminalViewerState => {
		const existing = streamState.viewers.get(clientId);
		if (existing) {
			return existing;
		}
		const created: TerminalViewerState = {
			clientId,
			pendingOutputChunks: [],
			pendingOutputBytes: 0,
			laggedOut: false,
			restoreComplete: false,
			ioState: null,
			ioSocket: null,
			controlSocket: null,
			detachControlListener: null,
			flushPendingOutput: () => {
				if (!created.restoreComplete || !created.ioState || created.laggedOut) return;
				const chunks = created.pendingOutputChunks;
				created.pendingOutputChunks = [];
				created.pendingOutputBytes = 0;
				for (const chunk of chunks) {
					if (created.laggedOut) break;
					created.ioState.enqueueOutput(chunk);
				}
			},
		};
		streamState.viewers.set(clientId, created);
		return created;
	};

	const cleanupViewerStateIfUnused = (
		connectionKey: string,
		streamState: TerminalStreamState,
		viewerState: TerminalViewerState,
	): void => {
		if (viewerState.ioSocket || viewerState.controlSocket) {
			return;
		}
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = null;
		streamState.viewers.delete(viewerState.clientId);
		cleanupTerminalStreamStateIfUnused(connectionKey);
	};

	/**
	 * Evict only the viewer that is behind. Pausing node-pty here blocks
	 * autonomous agents such as Pi once their terminal write buffer fills.
	 * The headless terminal mirror continues to record output for reconnect.
	 */
	const evictLaggingViewer = (streamState: TerminalStreamState, clientId: string): void => {
		const viewer = streamState.viewers.get(clientId);
		if (!viewer || viewer.laggedOut) return;
		viewer.laggedOut = true;
		viewer.restoreComplete = false;
		viewer.pendingOutputChunks = [];
		viewer.pendingOutputBytes = 0;
		viewer.ioState?.dispose();
		viewer.ioSocket?.terminate();
		viewer.controlSocket?.terminate();
	};

	const createIoOutputState = (ws: WebSocket, streamState: TerminalStreamState, clientId: string): IoOutputState => {
		let pendingOutputChunks: Buffer[] = [];
		let pendingOutputBytes = 0;
		let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
		let lastOutputSentAt = 0;
		let unacknowledgedOutputBytes = 0;
		let disposed = false;

		const sendOutputChunk = (chunk: Buffer) => {
			if (disposed || ws.readyState !== ws.OPEN) return;
			unacknowledgedOutputBytes += chunk.byteLength;
			if (unacknowledgedOutputBytes > MAX_VIEWER_UNACKNOWLEDGED_BYTES) {
				evictLaggingViewer(streamState, clientId);
				return;
			}
			ws.send(chunk);
			lastOutputSentAt = Date.now();
			if (ws.bufferedAmount > MAX_VIEWER_SOCKET_BUFFERED_BYTES) {
				evictLaggingViewer(streamState, clientId);
			}
		};

		const flushOutputBatch = () => {
			outputFlushTimer = null;
			if (disposed || pendingOutputChunks.length === 0 || ws.readyState !== ws.OPEN) {
				pendingOutputChunks = [];
				pendingOutputBytes = 0;
				return;
			}
			const chunk = Buffer.concat(pendingOutputChunks);
			pendingOutputChunks = [];
			pendingOutputBytes = 0;
			sendOutputChunk(chunk);
		};

		return {
			enqueueOutput: (chunk: Buffer) => {
				if (disposed || ws.readyState !== ws.OPEN) return;
				const now = Date.now();
				const sendImmediately =
					pendingOutputChunks.length === 0 &&
					outputFlushTimer === null &&
					chunk.byteLength <= LOW_LATENCY_CHUNK_BYTES &&
					now - lastOutputSentAt >= LOW_LATENCY_IDLE_WINDOW_MS;
				if (sendImmediately) {
					sendOutputChunk(chunk);
					return;
				}
				if (unacknowledgedOutputBytes + pendingOutputBytes + chunk.byteLength > MAX_VIEWER_UNACKNOWLEDGED_BYTES) {
					evictLaggingViewer(streamState, clientId);
					return;
				}
				pendingOutputChunks.push(chunk);
				pendingOutputBytes += chunk.byteLength;
				if (outputFlushTimer === null) {
					outputFlushTimer = setTimeout(flushOutputBatch, OUTPUT_BATCH_INTERVAL_MS);
				}
			},
			acknowledgeOutput: (bytes: number) => {
				unacknowledgedOutputBytes = Math.max(0, unacknowledgedOutputBytes - Math.max(0, Math.floor(bytes)));
			},
			dispose: () => {
				disposed = true;
				if (outputFlushTimer !== null) {
					clearTimeout(outputFlushTimer);
					outputFlushTimer = null;
				}
				pendingOutputChunks = [];
				pendingOutputBytes = 0;
			},
		};
	};

	const ensureOutputListener = (
		streamState: TerminalStreamState,
		taskId: string,
		terminalManager: TerminalSessionService,
	): void => {
		if (streamState.detachOutputListener) {
			return;
		}
		// Attach PTY output once per task session and fan it out to every viewer.
		// Earlier code attached per websocket, which made the same task effectively
		// last-viewer-wins across tabs.
		streamState.detachOutputListener = terminalManager.attach(taskId, {
			onOutput: (chunk) => {
				for (const viewerState of streamState.viewers.values()) {
					if (viewerState.laggedOut) continue;
					if (viewerState.restoreComplete && viewerState.ioState) {
						viewerState.ioState.enqueueOutput(chunk);
						continue;
					}
					if (viewerState.pendingOutputBytes + chunk.byteLength > MAX_VIEWER_PENDING_RESTORE_BYTES) {
						evictLaggingViewer(streamState, viewerState.clientId);
						continue;
					}
					viewerState.pendingOutputChunks.push(chunk);
					viewerState.pendingOutputBytes += chunk.byteLength;
				}
			},
		});
	};

	server.on("upgrade", (request, socket, head) => {
		try {
			(socket as Socket).setNoDelay(true);
			const upgradeRequest = request as UpgradeRequest;
			const url = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
			const pathname = url.pathname;
			const isIoRequest = isTerminalIoWebSocketPath(pathname);
			const isControlRequest = isTerminalControlWebSocketPath(pathname);
			if (!isIoRequest && !isControlRequest) {
				return;
			}
			if (handleSocketUpgrade(request, socket).end) {
				return;
			}
			// ── Passcode gate for terminal WebSocket upgrades ─────────────────
			if (validateUpgradeSession !== undefined && !validateUpgradeSession(request.headers.cookie)) {
				(socket as Socket).write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				(socket as Socket).destroy();
				return;
			}
			// ── End passcode gate ─────────────────────────────────────────────
			upgradeRequest.__kanbanUpgradeHandled = true;

			const taskId = url.searchParams.get("taskId")?.trim();
			const workspaceId = url.searchParams.get("workspaceId")?.trim();
			if (!taskId || !workspaceId) {
				socket.destroy();
				return;
			}
			const terminalManager = resolveTerminalManager(workspaceId);
			if (!terminalManager) {
				socket.destroy();
				return;
			}

			const targetServer = isIoRequest ? ioServer : controlServer;
			const clientId = getTerminalClientId(url);
			targetServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
				targetServer.emit("connection", ws, { taskId, workspaceId, clientId, terminalManager });
			});
		} catch {
			socket.destroy();
		}
	});

	ioServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const workspaceId = (context as TerminalWebSocketConnectionContext).workspaceId;
		const clientId = (context as TerminalWebSocketConnectionContext).clientId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(workspaceId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const streamState = getOrCreateTerminalStreamState(connectionKey);
		const viewerState = getOrCreateViewerState(streamState, clientId);
		const previousIoSocket = viewerState.ioSocket;
		viewerState.ioState?.dispose();
		viewerState.ioState = createIoOutputState(ws, streamState, clientId);
		viewerState.ioSocket = ws;
		viewerState.laggedOut = false;
		// `restoreComplete` is the control channel's promise that the viewer has a
		// current screen, so only a control connection may revoke it. Revoking it
		// here would strand an I/O-only reconnect — the bytes produced while the
		// stream was down are already queued below — until the pending cap evicted
		// the viewer, and would make the server depend on which socket connects first.
		viewerState.flushPendingOutput();
		ensureOutputListener(streamState, taskId, terminalManager);
		if (previousIoSocket && previousIoSocket !== ws) {
			previousIoSocket.close(1000, "Replaced by newer terminal stream.");
		}

		ws.on("message", (rawMessage: RawData) => {
			try {
				const summary = terminalManager.writeInput(taskId, rawDataToBuffer(rawMessage));
				if (!summary) {
					ws.close(1011, "Task session is not running.");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ws.close(1011, message);
			}
		});

		ws.on("close", () => {
			if (viewerState.ioSocket !== ws) {
				return;
			}
			viewerState.ioSocket = null;
			viewerState.ioState?.dispose();
			viewerState.ioState = null;
			cleanupViewerStateIfUnused(connectionKey, streamState, viewerState);
		});
	});

	controlServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const workspaceId = (context as TerminalWebSocketConnectionContext).workspaceId;
		const clientId = (context as TerminalWebSocketConnectionContext).clientId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(workspaceId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const streamState = getOrCreateTerminalStreamState(connectionKey);
		const viewerState = getOrCreateViewerState(streamState, clientId);
		const previousControlSocket = viewerState.controlSocket;
		viewerState.restoreComplete = false;
		viewerState.laggedOut = false;
		viewerState.pendingOutputChunks = [];
		viewerState.pendingOutputBytes = 0;
		viewerState.controlSocket = ws;
		ensureOutputListener(streamState, taskId, terminalManager);
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = terminalManager.attach(taskId, {
			onState: (summary) => {
				sendControlMessage(ws, {
					type: "state",
					summary,
				});
			},
			onExit: (code) => {
				sendControlMessage(ws, {
					type: "exit",
					code,
				});
			},
		});
		if (previousControlSocket && previousControlSocket !== ws) {
			previousControlSocket.close(1000, "Replaced by newer terminal control connection.");
		}

		void terminalManager
			.getRestoreSnapshot(taskId)
			.then((snapshot) => {
				sendControlMessage(ws, {
					type: "restore",
					snapshot: snapshot?.snapshot ?? "",
					cols: snapshot?.cols ?? null,
					rows: snapshot?.rows ?? null,
				});
			})
			.catch(() => {
				sendControlMessage(ws, {
					type: "restore",
					snapshot: "",
					cols: null,
					rows: null,
				});
			});

		ws.on("message", (rawMessage: RawData) => {
			const message = parseWebSocketPayload(rawMessage);
			if (!message) {
				sendControlMessage(ws, {
					type: "error",
					message: "Invalid terminal control payload.",
				});
				return;
			}

			if (message.type === "resize") {
				terminalManager.resize(taskId, message.cols, message.rows, message.pixelWidth, message.pixelHeight);
				return;
			}

			if (message.type === "stop") {
				terminalManager.stopTaskSession(taskId);
				return;
			}

			if (message.type === "output_ack") {
				viewerState.ioState?.acknowledgeOutput(message.bytes);
				return;
			}

			if (message.type === "restore_complete") {
				viewerState.restoreComplete = true;
				viewerState.flushPendingOutput();
			}
		});

		ws.on("close", () => {
			if (viewerState.controlSocket !== ws) {
				return;
			}
			viewerState.controlSocket = null;
			viewerState.detachControlListener?.();
			viewerState.detachControlListener = null;
			cleanupViewerStateIfUnused(connectionKey, streamState, viewerState);
		});
	});

	return {
		close: async () => {
			for (const client of ioServer.clients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			for (const client of controlServer.clients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			await new Promise<void>((resolveCloseWebSockets) => {
				ioServer.close(() => {
					controlServer.close(() => {
						resolveCloseWebSockets();
					});
				});
			});
			for (const socket of activeSockets) {
				try {
					socket.destroy();
				} catch {
					// Ignore socket destroy errors during shutdown.
				}
			}
		},
	};
}
