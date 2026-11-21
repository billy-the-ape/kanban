// AA-S1 launch primitives shared by every terminal agent adapter (including the
// Pi adapter in `pi-session-adapter.ts`). They live here instead of inside
// `agent-session-adapters.ts` so an adapter can be its own file without
// importing values back from the registry (which would be a circular import).
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { RuntimeAgentId } from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

/**
 * Identity of the launch that owns generated resources and emitted hook
 * events. `attemptId` is the AA-S1 token, not a secret and never event content.
 */
export interface LaunchHookContext {
	taskId: string;
	workspaceId: string;
	attemptId?: string | undefined;
}

/** An input shape that carries the launch identity used by `resolveHookContext`. */
export interface LaunchHookContextSource {
	taskId: string;
	workspaceId?: string | undefined;
	attemptId?: string | undefined;
}

export interface ScopedLaunchResources {
	/** Directory holding this attempt's generated integration files. */
	directory: string;
	/** Tear-down hook that removes only this attempt's directory. */
	cleanup: () => Promise<void>;
}

export interface PromptLaunch {
	args: string[];
	env: Record<string, string | undefined>;
}

export function resolveHookContext(input: LaunchHookContextSource): LaunchHookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	const attemptId = input.attemptId?.trim();
	return {
		taskId: input.taskId,
		workspaceId,
		...(attemptId ? { attemptId } : {}),
	};
}

/** `kanban hooks …` argument array for one generated integration hook. */
export function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

export function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

/** AA-S1: bounded, collision-resistant path segment for a generated resource. */
export function toResourceScopeSegment(value: string): string {
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
	const readable = value
		.normalize("NFKD")
		.replaceAll(/[^A-Za-z0-9._-]+/g, "-")
		.replaceAll(/^[-.]+|[-.]+$/g, "")
		.slice(0, 48);
	return `${readable.length > 0 ? readable : "scope"}-${hash}`;
}

/**
 * AA-S1: generated integration resources are scoped by workspace, task and
 * launch attempt. A stale plugin, a second task on the same agent, or a
 * restarted attempt never reads or overwrites another attempt's files.
 * Sessions without a workspace (the home agent) keep the shared agent
 * directory, which is all they ever addressed.
 */
export function getScopedHookAgentDirectory(agentId: RuntimeAgentId, hooks: LaunchHookContext | null): string {
	const base = getHookAgentDirectory(agentId);
	if (!hooks) {
		return base;
	}
	return join(
		base,
		toResourceScopeSegment(hooks.workspaceId),
		toResourceScopeSegment(hooks.taskId),
		toResourceScopeSegment(hooks.attemptId ?? "launch"),
	);
}

/**
 * Removes one attempt-scoped resource directory on teardown. Refuses anything
 * that is not inside Kanban's own hooks root, so a cleanup can never reach
 * durable state or a user-owned file.
 */
export function createHookResourceCleanup(directory: string): () => Promise<void> {
	return async () => {
		const hooksRoot = join(getRuntimeHomePath(), "hooks");
		const relativePath = relative(hooksRoot, directory);
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			return;
		}
		await rm(directory, { recursive: true, force: true }).catch(() => {
			// Best effort: a leftover generated file is never worth failing a teardown.
		});
	};
}

export function createScopedHookResources(agentId: RuntimeAgentId, hooks: LaunchHookContext): ScopedLaunchResources {
	const directory = getScopedHookAgentDirectory(agentId, hooks);
	return { directory, cleanup: createHookResourceCleanup(directory) };
}

export async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

export function hasCliOption(args: readonly string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

/** Appends the launch prompt as a positional argument or behind one flag. */
export function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PromptLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}
