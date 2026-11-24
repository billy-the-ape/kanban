import { join } from "node:path";
import type { ClineTurnTarget } from "../cline-sdk/cline-turn-scheduler";
import { getPiAgentDir, readPiModelDefaults } from "./pi-session-options";
import { readFile } from "node:fs/promises";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function argumentAfter(args: readonly string[], flag: string): string | null {
	const index = args.lastIndexOf(flag);
	if (index >= 0) return args[index + 1]?.trim() || null;
	const prefix = `${flag}=`;
	for (let index = args.length - 1; index >= 0; index -= 1) {
		const arg = args[index];
		if (arg?.startsWith(prefix)) return arg.slice(prefix.length).trim() || null;
	}
	return null;
}

/**
 * Discover Pi's model endpoint without loading its credential/auth files or
 * copying its API keys into Kanban. Pi remains the source of truth for auth.
 * When models.json lacks a local endpoint, capacity discovery safely falls
 * back to one slot (the persistent manual override still works).
 */
export async function resolvePiTurnTarget(args: readonly string[] = []): Promise<ClineTurnTarget> {
	const defaults = await readPiModelDefaults();
	const modelId = argumentAfter(args, "--model") ?? defaults.defaultModel;
	const providerId = argumentAfter(args, "--provider") ?? defaults.defaultProvider ?? "pi";
	let baseUrl: string | null = null;
	try {
		const raw = await readFile(join(getPiAgentDir(), "models.json"), "utf8");
		const providers = asRecord(asRecord(JSON.parse(raw) as unknown)?.providers);
		const provider = asRecord(providers?.[providerId]);
		const candidate = typeof provider?.baseUrl === "string" ? provider.baseUrl.trim() : "";
		if (candidate) {
			const url = new URL(candidate);
			if (url.protocol === "http:" || url.protocol === "https:") baseUrl = candidate;
		}
	} catch {
		// An absent or invalid Pi catalogue is normal; the shared scheduler
		// discovers one safe slot unless a user overrides the capacity.
	}
	return { providerId, modelId, baseUrl };
}
