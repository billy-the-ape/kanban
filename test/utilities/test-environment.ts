import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Isolate process-wide Git routing, user config, and SDK storage before imports.
 * cwd and git -C alone do not override repository variables exported by hooks.
 */
export function isolateTestEnvironment(env: NodeJS.ProcessEnv = process.env): {
	home: string;
	cleanup: () => void;
} {
	const home = mkdtempSync(join(tmpdir(), "kanban-test-home-"));
	const overrides: NodeJS.ProcessEnv = {
		HOME: home,
		USERPROFILE: home,
		CLINE_DIR: join(home, ".cline"),
		CLINE_LOG_PATH: join(home, ".cline", "logs", "test.log"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		APPDATA: join(home, ".config"),
		LOCALAPPDATA: join(home, ".local", "share"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		if (key.toUpperCase().startsWith("GIT_")) {
			previous.set(key, value);
			delete env[key];
		}
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (!previous.has(key)) {
			previous.set(key, env[key]);
		}
		env[key] = value;
		if (value && key !== "GIT_CONFIG_NOSYSTEM") {
			mkdirSync(key === "CLINE_LOG_PATH" ? dirname(value) : value, { recursive: true });
		}
	}
	let cleaned = false;
	return {
		home,
		cleanup: () => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			for (const key of Object.keys(env)) {
				if (key.toUpperCase().startsWith("GIT_")) {
					delete env[key];
				}
			}
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete env[key];
				} else {
					env[key] = value;
				}
			}
			rmSync(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
		},
	};
}
