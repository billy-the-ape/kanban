import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Minimal read view over a checkout (a repository working tree or task
 * worktree) so dependency detection can be exercised without touching disk.
 * All paths are relative to the checkout root and POSIX separated; `.` is the
 * root itself.
 */
export interface CheckoutReader {
	/** File content, or null when the path is missing or unreadable. */
	readText(relativePath: string): Promise<string | null>;
	/** Immediate subdirectory names of a directory ([] when missing). */
	listChildDirectories(relativePath: string): Promise<string[]>;
	/** True when the path resolves to an existing directory. */
	directoryExists(relativePath: string): Promise<boolean>;
}

export function toCheckoutRelativePath(relativePath: string): string {
	const segments = relativePath
		.trim()
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".");
	return segments.length === 0 ? "." : segments.join("/");
}

export function joinCheckoutPath(relativePath: string, child: string): string {
	const parent = toCheckoutRelativePath(relativePath);
	return parent === "." ? toCheckoutRelativePath(child) : toCheckoutRelativePath(`${parent}/${child}`);
}

export function createFsCheckoutReader(rootPath: string): CheckoutReader {
	const resolve = (relativePath: string): string => join(rootPath, toCheckoutRelativePath(relativePath));
	return {
		async readText(relativePath) {
			return await readFile(resolve(relativePath), "utf8").catch(() => null);
		},
		async listChildDirectories(relativePath) {
			const entries = await readdir(resolve(relativePath), { withFileTypes: true }).catch(() => []);
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		},
		async directoryExists(relativePath) {
			const info = await stat(resolve(relativePath)).catch(() => null);
			return info?.isDirectory() === true;
		},
	};
}
