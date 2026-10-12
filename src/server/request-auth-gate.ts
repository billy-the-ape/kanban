/**
 * Shared runtime request auth gate and workspace-scope resolution.
 *
 * This module is the single source of truth for the passcode/session/bearer
 * gate so that the production request handler, WebSocket upgrade paths, and
 * tests all exercise the exact same code instead of re-implementing it.
 *
 * Behaviour notes (must stay preserved):
 * - `/api/passcode/status` responds for ANY method, before any auth check.
 * - `/api/passcode/verify` is only handled for POST.
 * - Unauthenticated non-API paths (static assets, index.html) fall through
 *   so the React app can boot and render the passcode gate.
 * - Authentication is a valid `kanban_session` cookie (browser flow) OR the
 *   internal CLI bearer token (CLI flow).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	checkRateLimit,
	clearRateLimit,
	extractBearerToken,
	extractSessionTokenFromCookie,
	isPasscodeEnabled,
	issueSession,
	recordFailedAttempt,
	validateInternalToken,
	validatePasscode,
	validateSession,
} from "../security/passcode-manager";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";

/**
 * Whether an incoming request carries valid runtime credentials: a valid
 * `kanban_session` cookie (browser flow) or the internal CLI bearer token.
 */
export function isRuntimeRequestAuthenticated(request: Pick<IncomingMessage, "headers">): boolean {
	// Check session cookie (browser flow) first, then internal bearer token (CLI flow).
	const sessionToken = extractSessionTokenFromCookie(request.headers.cookie);
	const sessionAuth = sessionToken !== null && validateSession(sessionToken);
	if (sessionAuth) {
		return true;
	}
	const bearerToken = extractBearerToken(request.headers.authorization);
	const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
	return internalAuth;
}

export interface RuntimeHttpAuthGateOptions {
	/** True when the runtime is bound to a non-localhost host (remote mode). */
	isRemoteMode: boolean;
	/** True when the runtime listens over TLS; adds the Secure flag to the session cookie. */
	isTls: boolean;
}

export interface RuntimeHttpAuthGateResult {
	/** True when the gate wrote a complete response and the caller must not continue. */
	handled: boolean;
}

const readRequestBody = (request: IncomingMessage, maxBytes = 4096): Promise<string> =>
	new Promise((resolve, reject) => {
		let body = "";
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("Request body too large"));
				return;
			}
			body += chunk.toString("utf8");
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});

const getRemoteIp = (request: IncomingMessage): string => request.socket.remoteAddress ?? "unknown";

/**
 * Passcode gate for HTTP requests (remote mode only).
 *
 * Handles the `/api/passcode/status` and `/api/passcode/verify` endpoints and
 * the authenticated/401/fall-through decision for every other path. Returns
 * `handled: true` when a response was written; the caller must then stop.
 * Otherwise the request is authenticated (or the gate is inactive / the path
 * is a public asset) and the caller continues normal routing.
 */
export async function handleRuntimeHttpAuthGate(
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
	options: RuntimeHttpAuthGateOptions,
): Promise<RuntimeHttpAuthGateResult> {
	// ── Passcode gate (remote mode only) ──────────────────────────────
	const passcodeActive = options.isRemoteMode && isPasscodeEnabled();
	if (pathname === "/api/passcode/status") {
		if (passcodeActive) {
			const token = extractSessionTokenFromCookie(request.headers.cookie);
			const authenticated = token !== null && validateSession(token);
			response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			response.end(JSON.stringify({ required: true, authenticated }));
		} else {
			response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			response.end(JSON.stringify({ required: false, authenticated: true }));
		}
		return { handled: true };
	}
	if (passcodeActive && request.method === "POST" && pathname === "/api/passcode/verify") {
		const ip = getRemoteIp(request);
		const rateLimit = checkRateLimit(ip);
		if (!rateLimit.allowed) {
			const retryAfterSec = rateLimit.lockedUntilMs ? Math.ceil((rateLimit.lockedUntilMs - Date.now()) / 1000) : 30;
			response.writeHead(429, {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
				"Retry-After": String(retryAfterSec),
			});
			response.end(JSON.stringify({ error: "Too many attempts. Please wait before trying again." }));
			return { handled: true };
		}
		let body: string;
		try {
			body = await readRequestBody(request);
		} catch {
			response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: "Invalid request body." }));
			return { handled: true };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: "Invalid JSON." }));
			return { handled: true };
		}
		const submitted =
			parsed !== null &&
			typeof parsed === "object" &&
			"passcode" in parsed &&
			typeof (parsed as Record<string, unknown>).passcode === "string"
				? ((parsed as Record<string, unknown>).passcode as string)
				: "";
		if (!validatePasscode(submitted)) {
			recordFailedAttempt(ip);
			response.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			response.end(JSON.stringify({ error: "Invalid passcode." }));
			return { handled: true };
		}
		clearRateLimit(ip);
		const token = issueSession();
		const cookieFlags = [
			`kanban_session=${token}`,
			"HttpOnly",
			"SameSite=Strict",
			"Path=/",
			`Max-Age=${24 * 60 * 60}`,
			...(options.isTls ? ["Secure"] : []),
		].join("; ");
		response.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"Set-Cookie": cookieFlags,
		});
		response.end(JSON.stringify({ ok: true }));
		return { handled: true };
	}
	if (passcodeActive && !isRuntimeRequestAuthenticated(request)) {
		// Static assets (JS, CSS, images, fonts, icons, manifest) are served
		// freely even when unauthenticated. They contain no user data and are
		// required for the React app to boot and render the passcode gate.
		// Only API routes are hard-blocked; index.html is served normally so
		// PasscodeGateProvider in React can intercept before any API calls.
		if (pathname.startsWith("/api/")) {
			response.writeHead(401, {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
			});
			response.end(JSON.stringify({ error: "Authentication required." }));
			return { handled: true };
		}
		// Fall through — let the normal asset/index.html serving handle it.
		// PasscodeGateProvider in main.tsx will render the gate before any
		// authenticated API calls are made.
	}
	// ── End passcode gate ──────────────────────────────────────────────

	return { handled: false };
}

/**
 * Read the requested workspace id from the `x-kanban-workspace-id` header
 * (preferred) or the `workspaceId` query parameter.
 */
export function readWorkspaceIdFromRequest(request: Pick<IncomingMessage, "headers">, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

/**
 * Resolve the tRPC workspace scope for a request: the requested workspace id
 * plus its registered scope when the workspace is known.
 */
export async function resolveWorkspaceScopeFromRequest(
	request: Pick<IncomingMessage, "headers">,
	requestUrl: URL,
): Promise<{
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
}> {
	const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl);
	if (!requestedWorkspaceId) {
		return {
			requestedWorkspaceId: null,
			workspaceScope: null,
		};
	}
	const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
	if (!requestedWorkspaceContext) {
		return {
			requestedWorkspaceId,
			workspaceScope: null,
		};
	}
	return {
		requestedWorkspaceId,
		workspaceScope: {
			workspaceId: requestedWorkspaceContext.workspaceId,
			workspacePath: requestedWorkspaceContext.repoPath,
		},
	};
}
