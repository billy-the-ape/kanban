/**
 * DIAG-1: tests for the extracted runtime auth gate and workspace-scope
 * resolution in src/server/request-auth-gate.ts.
 *
 * The gate is exercised through the same wiring the production requestHandler
 * uses (gate first, then normal routing), via a small http.createServer
 * wrapper — no full runtime server boot.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	disablePasscode,
	generateInternalToken,
	generatePasscode,
	issueSession,
	revokeAndRegeneratePasscode,
} from "../../../src/security/passcode-manager";
import { normalizeRequestPath } from "../../../src/server/assets";
import {
	handleRuntimeHttpAuthGate,
	isRuntimeRequestAuthenticated,
	type RuntimeHttpAuthGateOptions,
	resolveWorkspaceScopeFromRequest,
} from "../../../src/server/request-auth-gate";
import { loadWorkspaceContext } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startGateServer(options: RuntimeHttpAuthGateOptions): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);
			const result = await handleRuntimeHttpAuthGate(req, res, pathname, options);
			if (result.handled) {
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ reached: true }));
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address() as AddressInfo;
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}`,
				close: () =>
					new Promise<void>((resolveClose, rejectClose) => {
						server.close((error) => (error ? rejectClose(error) : resolveClose()));
					}),
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Gate decision scenarios (the plan's behaviour-unchanged matrix)
// ---------------------------------------------------------------------------

describe("handleRuntimeHttpAuthGate", () => {
	let close: (() => Promise<void>) | null = null;

	afterEach(async () => {
		await close?.();
		close = null;
		// Reset passcode/session/rate-limit state so tests do not bleed.
		revokeAndRegeneratePasscode();
	});

	it("continues unauthenticated API requests when NOT in remote mode", async () => {
		const server = await startGateServer({ isRemoteMode: false, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/trpc`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});

	it("continues unauthenticated API requests when the passcode is disabled in remote mode", async () => {
		disablePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/trpc`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});

	it("continues API requests with a valid session cookie", async () => {
		generatePasscode();
		const token = issueSession();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/trpc`, {
			headers: { cookie: `kanban_session=${token}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});

	it("continues API requests with a valid internal bearer token", async () => {
		generatePasscode();
		const token = generateInternalToken();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/trpc`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});

	it("rejects unauthenticated API requests with 401", async () => {
		generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/trpc`);
		expect(response.status).toBe(401);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ error: "Authentication required." });
	});

	it("rejects API requests with an invalid bearer token", async () => {
		generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/trpc`, {
			headers: { authorization: "Bearer not-a-real-token" },
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Authentication required." });
	});

	it("allows unauthenticated non-API paths (static assets) through", async () => {
		generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/assets/app.js`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});

	it("does not handle non-POST requests to /api/passcode/verify", async () => {
		generatePasscode();
		const token = issueSession();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/verify`, {
			headers: { cookie: `kanban_session=${token}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});
});

// ---------------------------------------------------------------------------
// Passcode endpoints
// ---------------------------------------------------------------------------

describe("/api/passcode/status", () => {
	let close: (() => Promise<void>) | null = null;

	afterEach(async () => {
		await close?.();
		close = null;
		revokeAndRegeneratePasscode();
	});

	it("reports required + authenticated for a valid session cookie", async () => {
		generatePasscode();
		const token = issueSession();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/status`, {
			headers: { cookie: `kanban_session=${token}` },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ required: true, authenticated: true });
	});

	it("reports required + unauthenticated without a session cookie", async () => {
		generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/status`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ required: true, authenticated: false });
	});

	it("reports not required when the passcode is inactive", async () => {
		disablePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/status`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ required: false, authenticated: true });
	});
});

describe("/api/passcode/verify", () => {
	let close: (() => Promise<void>) | null = null;

	afterEach(async () => {
		await close?.();
		close = null;
		revokeAndRegeneratePasscode();
	});

	it("issues a session cookie for the correct passcode", async () => {
		const passcode = generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ passcode }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		const setCookie = response.headers.get("set-cookie");
		expect(setCookie).toBeTruthy();
		expect(setCookie).toContain("kanban_session=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Max-Age=86400");
		expect(setCookie).not.toContain("Secure");
		// The issued cookie authenticates API requests.
		const sessionToken = (setCookie ?? "").split(";")[0].replace("kanban_session=", "");
		const apiResponse = await fetch(`${server.baseUrl}/api/trpc`, {
			headers: { cookie: `kanban_session=${sessionToken}` },
		});
		expect(apiResponse.status).toBe(200);
	});

	it("adds the Secure cookie flag when the runtime listens over TLS", async () => {
		const passcode = generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: true });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ passcode }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain("Secure");
	});

	it("rejects an invalid passcode with 401", async () => {
		generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ passcode: "wrong-passcode" }),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid passcode." });
	});

	it("returns 400 for an invalid JSON body", async () => {
		const passcode = generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		const response = await fetch(`${server.baseUrl}/api/passcode/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: `not-json ${passcode}`,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid JSON." });
	});

	it("locks out with 429 and Retry-After after five failed attempts", async () => {
		generatePasscode();
		const server = await startGateServer({ isRemoteMode: true, isTls: false });
		close = server.close;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await fetch(`${server.baseUrl}/api/passcode/verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ passcode: "wrong-passcode" }),
			});
			expect(response.status).toBe(401);
		}
		const locked = await fetch(`${server.baseUrl}/api/passcode/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ passcode: "wrong-passcode" }),
		});
		expect(locked.status).toBe(429);
		expect(locked.headers.get("retry-after")).toBeTruthy();
		expect(await locked.json()).toEqual({ error: "Too many attempts. Please wait before trying again." });
	});
});

// ---------------------------------------------------------------------------
// Shared authentication predicate (WS upgrade gate uses the same check)
// ---------------------------------------------------------------------------

describe("isRuntimeRequestAuthenticated", () => {
	afterEach(() => {
		revokeAndRegeneratePasscode();
	});

	it("accepts a valid session cookie", () => {
		generatePasscode();
		const token = issueSession();
		expect(isRuntimeRequestAuthenticated({ headers: { cookie: `kanban_session=${token}` } })).toBe(true);
	});

	it("accepts a valid internal bearer token", () => {
		generatePasscode();
		const token = generateInternalToken();
		expect(isRuntimeRequestAuthenticated({ headers: { authorization: `Bearer ${token}` } })).toBe(true);
	});

	it("rejects requests with no credentials", () => {
		generatePasscode();
		expect(isRuntimeRequestAuthenticated({ headers: {} })).toBe(false);
	});

	it("rejects invalid credentials", () => {
		generatePasscode();
		expect(
			isRuntimeRequestAuthenticated({
				headers: { cookie: "kanban_session=bogus", authorization: "Bearer bogus" },
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Workspace-scope resolution
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string>): IncomingMessage {
	return { headers } as IncomingMessage;
}

describe("resolveWorkspaceScopeFromRequest", () => {
	let tempHome: { path: string; cleanup: () => void } | null = null;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	function beginIsolatedHome(): string {
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		const homePath = mkdtempSync(join(tmpdir(), "kanban-scope-home-"));
		tempHome = {
			path: homePath,
			cleanup: () => rmSync(homePath, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }),
		};
		process.env.HOME = homePath;
		process.env.USERPROFILE = homePath;
		return homePath;
	}

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		tempHome?.cleanup();
		tempHome = null;
	});

	it("returns null scope when no workspace id is supplied", async () => {
		beginIsolatedHome();

		const result = await resolveWorkspaceScopeFromRequest(makeRequest({}), new URL("http://localhost/"));
		expect(result).toEqual({ requestedWorkspaceId: null, workspaceScope: null });
	});

	it("prefers the x-kanban-workspace-id header over the query parameter and trims it", async () => {
		beginIsolatedHome();

		const result = await resolveWorkspaceScopeFromRequest(
			makeRequest({ "x-kanban-workspace-id": "  ws-header  " }),
			new URL("http://localhost/?workspaceId=ws-query"),
		);
		expect(result.requestedWorkspaceId).toBe("ws-header");
		expect(result.workspaceScope).toBeNull();
	});

	it("returns a null scope for an unknown workspace id", async () => {
		beginIsolatedHome();

		const result = await resolveWorkspaceScopeFromRequest(
			makeRequest({}),
			new URL("http://localhost/?workspaceId=does-not-exist"),
		);
		expect(result).toEqual({ requestedWorkspaceId: "does-not-exist", workspaceScope: null });
	});

	it("resolves the registered workspace scope from a known workspace id", async () => {
		const homePath = beginIsolatedHome();

		const repoDir = mkdtempSync(join(homePath, "kanban-scope-repo-"));
		execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, env: createGitTestEnv(), stdio: "ignore" });
		const context = await loadWorkspaceContext(repoDir);

		const result = await resolveWorkspaceScopeFromRequest(
			makeRequest({}),
			new URL(`http://localhost/?workspaceId=${encodeURIComponent(context.workspaceId)}`),
		);
		expect(result).toEqual({
			requestedWorkspaceId: context.workspaceId,
			workspaceScope: { workspaceId: context.workspaceId, workspacePath: context.repoPath },
		});
	});
});
