import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import { LockedFileSystem } from "../../src/fs/locked-file-system";

describe("LockedFileSystem", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
	});

	it("omits onCompromised when no handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options).not.toHaveProperty("onCompromised");
			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	it("forwards onCompromised when a handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const onCompromised = vi.fn();

			await lockedFileSystem.withLock({ path: filePath, type: "file", onCompromised }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.onCompromised).toBe(onCompromised);
		} finally {
			tempDir.cleanup();
		}
	});

	it("names the lock that could not be taken and keeps the ELOCKED code", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			lockfileMocks.lock.mockRejectedValueOnce(
				Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" }),
			);

			let failure: unknown;
			try {
				await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});
			} catch (error) {
				failure = error;
			}

			if (!(failure instanceof Error)) {
				throw new Error("Expected the busy lock to reject.");
			}
			// The runtime home holds several distinct locks and a failed startup prints
			// this message on its own, so it has to say which lock stalled. Callers
			// branch on `code`, so annotating the message must keep it.
			expect(failure.message).toBe(`Lock file is already being held (lock: ${filePath}.lock)`);
			expect(failure).toMatchObject({ code: "ELOCKED" });
		} finally {
			tempDir.cleanup();
		}
	});
});
