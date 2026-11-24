import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalResetMock = vi.hoisted(() => vi.fn());
const terminalWriteMock = vi.hoisted(() => vi.fn());

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		options = { theme: {} };
		unicode = { activeVersion: "" };
		loadAddon() {}
		open() {}
		onData() {}
		onBinary() {}
		attachCustomKeyEventHandler() {}
		resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
		write(data: string | Uint8Array, callback?: () => void) {
			terminalWriteMock(data);
			callback?.();
		}
		reset() { terminalResetMock(); }
		focus() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class { fit() {} },
}));
vi.mock("@xterm/addon-clipboard", () => ({
	ClipboardAddon: class {},
}));
vi.mock("@xterm/addon-unicode11", () => ({
	Unicode11Addon: class {},
}));
vi.mock("@xterm/addon-web-links", () => ({
	WebLinksAddon: class {},
}));
vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class { onContextLoss() {} dispose() {} },
}));
vi.mock("@/hooks/use-theme", () => ({
	getTerminalThemeColors: () => ({ foreground: "#fff", background: "#000" }),
}));
vi.mock("@/terminal/terminal-geometry-registry", () => ({
	clearTerminalGeometry: vi.fn(), reportTerminalGeometry: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { stopTaskSession: { mutate: vi.fn() } } }),
}));

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

class MockSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	readonly sent: string[] = [];
	readonly url: string;
	readyState = 0;
	binaryType = "blob";
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		sockets.push(this);
	}

	addEventListener() {}
	send(data: string) { this.sent.push(data); }
	close() {
		if (this.readyState === MockSocket.CLOSED) return;
		this.readyState = MockSocket.CLOSED;
		this.onclose?.();
	}
	open() {
		this.readyState = MockSocket.OPEN;
		this.onopen?.();
	}
	receive(message: unknown) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
}
const sockets: MockSocket[] = [];

async function flushTerminalWrites() {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("persistent terminal background recovery", () => {
	let visibility = "visible";
	let previousDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		sockets.length = 0;
		terminalResetMock.mockReset();
		terminalWriteMock.mockReset();
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockSocket);
		vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
		previousDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
		visibility = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true, get: () => visibility,
		});
	});

	afterEach(() => {
		disposePersistentTerminal("workspace-a", "task-a");
		document.getElementById("kb-persistent-terminal-parking-root")?.remove();
		if (previousDescriptor) {
			Object.defineProperty(document, "visibilityState", previousDescriptor);
		} else {
			Reflect.deleteProperty(document, "visibilityState");
		}
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("disconnects only the viewer while hidden and restores the snapshot on foreground", async () => {
		ensurePersistentTerminal({
			taskId: "task-a", workspaceId: "workspace-a",
			terminalBackgroundColor: "#000", cursorColor: "#fff",
		});
		expect(sockets).toHaveLength(2);
		for (const socket of sockets) socket.open();
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(sockets.every((socket) => socket.readyState === MockSocket.CLOSED)).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sockets).toHaveLength(2);

		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(sockets).toHaveLength(4);
		for (const socket of sockets.slice(2)) socket.open();
		const control = sockets[3];
		control?.receive({ type: "restore", snapshot: "saved screen", cols: 80, rows: 24 });
		await flushTerminalWrites();
		expect(terminalResetMock).toHaveBeenCalled();
		expect(terminalWriteMock).toHaveBeenCalledWith("saved screen");
		expect(control?.sent).toContain(JSON.stringify({ type: "restore_complete" }));
	});

	it("reconnects both channels after the server evicts a slow viewer", async () => {
		ensurePersistentTerminal({
			taskId: "task-a", workspaceId: "workspace-a",
			terminalBackgroundColor: "#000", cursorColor: "#fff",
		});
		for (const socket of sockets) socket.open();
		sockets[0]?.close();
		expect(sockets[1]?.readyState).toBe(MockSocket.CLOSED);
		await vi.advanceTimersByTimeAsync(300);
		expect(sockets).toHaveLength(4);
		for (const socket of sockets.slice(2)) socket.open();
		const control = sockets[3];
		control?.receive({ type: "restore", snapshot: "new server screen", cols: 80, rows: 24 });
		await flushTerminalWrites();
		expect(terminalWriteMock).toHaveBeenCalledWith("new server screen");
		expect(control?.sent).toContain(JSON.stringify({ type: "restore_complete" }));
	});

	it("does not connect a terminal constructed in a background tab", () => {
		visibility = "hidden";
		ensurePersistentTerminal({
			taskId: "task-a", workspaceId: "workspace-a",
			terminalBackgroundColor: "#000", cursorColor: "#fff",
		});
		expect(sockets).toHaveLength(0);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(sockets).toHaveLength(2);
	});
});
