import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRIES: NonNullable<LockOptions["retries"]> = {
	retries: 200,
	factor: 1,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: false,
};

interface BaseLockRequest {
	path: string;
	staleMs?: number;
	retries?: LockOptions["retries"];
	onCompromised?: LockOptions["onCompromised"];
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

interface NormalizedLockRequest {
	path: string;
	options: LockOptions;
	sortKey: string;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
}

function createLockOptions(request: LockRequest, lockfilePath: string): LockOptions {
	const options: LockOptions = {
		stale: request.staleMs ?? DEFAULT_LOCK_STALE_MS,
		retries: request.retries ?? DEFAULT_LOCK_RETRIES,
		realpath: false,
		lockfilePath,
	};
	if (typeof request.onCompromised === "function") {
		options.onCompromised = request.onCompromised;
	}
	return options;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			const lockfilePath = request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		const lockfilePath = request.lockfilePath ?? `${request.path}.lock`;
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	/**
	 * proper-lockfile only ever reports "Lock file is already being held", and a
	 * failed startup prints that as its single line of output — with several
	 * distinct locks under the runtime home there is no way to tell which one
	 * stalled. Name the lock while keeping the original error (and its `ELOCKED`
	 * code) so callers that branch on the code keep working.
	 */
	private async acquireLock(request: NormalizedLockRequest): Promise<() => Promise<void>> {
		try {
			return await lockfile.lock(request.path, request.options);
		} catch (error) {
			if (error instanceof Error && !error.message.includes(request.sortKey)) {
				error.message = `${error.message} (lock: ${request.sortKey})`;
			}
			throw error;
		}
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const orderedRequests = normalizedRequests
			.slice()
			.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const request of orderedRequests) {
				releases.push(await this.acquireLock(request));
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) {
				await release();
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable) {
					await chmod(path, 0o755);
				}
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
			if (options.executable) {
				await chmod(path, 0o755);
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	/**
	 * Atomic write for arbitrary bytes (no UTF-8 round-trip, no content-dedup
	 * compare): the written file is byte-for-byte the provided buffer. Used for
	 * artifact archives whose byte offsets are cursors elsewhere.
	 */
	async writeBufferFileAtomic(path: string, content: Buffer, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content);
			await rename(tempPath, path);
			if (options.executable) {
				await chmod(path, 0o755);
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
