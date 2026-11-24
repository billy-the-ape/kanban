import { createHash } from "node:crypto";

import type { DependencyInputDigest, DependencyInputFile, WorktreePackageManagerId } from "./types";

/**
 * Bumped whenever the cache key or stored layout changes meaning, so an old
 * entry can never be restored into an incompatible worktree layout.
 */
export const DEPENDENCY_CACHE_SCHEMA_VERSION = 1;

export interface EnvironmentSignatureInput {
	platform?: string;
	arch?: string;
	nodeVersion?: string;
}

/**
 * Native modules are built for the running Node ABI and platform, so a tree
 * captured under Node 22 on linux/x64 must never be restored for Node 24 on
 * darwin/arm64. Node major only (not patch) to avoid churn on routine
 * upgrades, which keep the same ABI.
 */
export function computeEnvironmentSignature(input: EnvironmentSignatureInput = {}): string {
	const platform = input.platform ?? process.platform;
	const arch = input.arch ?? process.arch;
	const rawNodeVersion = input.nodeVersion ?? process.version;
	const major = /^(?:v)?(\d+)/.exec(rawNodeVersion)?.[1] ?? rawNodeVersion.replace(/[^0-9]/g, "");
	return `${sanitizeKeySegment(platform)}-${sanitizeKeySegment(arch)}-node${sanitizeKeySegment(major || "0")}`;
}

function sanitizeKeySegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._+-]/g, "");
}

export function digestInputs(inputs: readonly DependencyInputFile[]): DependencyInputDigest[] {
	return inputs
		.map((input) => ({
			path: input.path,
			sha256: createHash("sha256").update(input.content, "utf8").digest("hex"),
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
}

export interface InstallFingerprint {
	/** Directory-safe cache key: install scope, pm, environment, input hash. */
	key: string;
	/** Full input hash. */
	fingerprint: string;
	digests: DependencyInputDigest[];
}

/**
 * The cache key is a hash of everything the resulting tree depends on: the
 * install scope, the package manager, the environment signature, and every
 * manifest/lockfile the install consumes (byte-exact). Two checkouts with
 * equal digests get the same tree, which is what makes a worktree at a
 * refreshed base ref safe to reuse.
 */
export function computeInstallFingerprint(options: {
	installPath: string;
	packageManager: WorktreePackageManagerId;
	inputs: readonly DependencyInputFile[];
	environment?: string;
}): InstallFingerprint {
	const environment = options.environment ?? computeEnvironmentSignature();
	const digests = digestInputs(options.inputs);
	const canonical = [
		`schema=${DEPENDENCY_CACHE_SCHEMA_VERSION}`,
		`scope=${options.installPath === "." ? "." : options.installPath}`,
		`pm=${options.packageManager}`,
		`env=${environment}`,
		`inputs=${digests.map((digest) => `${digest.path}:${digest.sha256}`).join("\n")}`,
	].join("\n");
	const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
	const scope = options.installPath === "." ? "root" : sanitizeKeySegment(options.installPath).replace(/\//g, "-");
	const key = `${scope}__${options.packageManager}__${sanitizeKeySegment(environment)}__${fingerprint.slice(0, 24)}`;
	return { key, fingerprint, digests };
}
