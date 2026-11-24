import { describe, expect, it } from "vitest";
import type { CheckoutReader } from "../../src/workspace/dependencies/checkout-reader";
import { resolveTransferStrategy } from "../../src/workspace/dependencies/ensure-worktree-dependencies";
import { computeEnvironmentSignature, computeInstallFingerprint } from "../../src/workspace/dependencies/fingerprint";
import { buildInstallPlan, findExecutableOnPath } from "../../src/workspace/dependencies/install-plan";
import {
	detectInstallUnits,
	discoverInstallUnitOutputs,
	matchesWorkspacePattern,
	parseDeclaredPackageManager,
	parsePnpmWorkspacePatterns,
} from "../../src/workspace/dependencies/install-units";

/**
 * In-memory checkout: the files present imply the directories that contain
 * them, so detection sees the same shape it would on disk.
 */
function createMemoryReader(files: Record<string, string>, extraDirectories: readonly string[] = []): CheckoutReader {
	const filePaths = Object.keys(files).map((path) => path.replace(/^\.\//, ""));
	const directories = new Set<string>(["."]);
	const addAncestors = (path: string): void => {
		const segments = path.split("/");
		segments.pop();
		let current = ".";
		for (const segment of segments) {
			current = current === "." ? segment : `${current}/${segment}`;
			directories.add(current);
		}
	};
	for (const path of filePaths) {
		addAncestors(path);
	}
	for (const path of extraDirectories) {
		// Extra entries name directories themselves, so the directory and every
		// ancestor have to exist.
		const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
		if (normalized.length > 0 && normalized !== ".") {
			directories.add(normalized);
			addAncestors(`${normalized}/x`);
		}
	}
	const childDirectories = (relativePath: string): string[] => {
		const parent = relativePath === "." ? "" : `${relativePath}/`;
		return Array.from(directories)
			.filter((directory) => {
				if (parent.length === 0) {
					return directory !== "." && !directory.includes("/");
				}
				return directory.startsWith(parent) && !directory.slice(parent.length).includes("/");
			})
			.map((directory) => (parent.length === 0 ? directory : directory.slice(parent.length)));
	};
	return {
		async readText(relativePath) {
			const normalized = relativePath.replace(/^\.\//, "");
			return Object.hasOwn(files, normalized) ? files[normalized] : null;
		},
		async listChildDirectories(relativePath) {
			return childDirectories(relativePath === "." ? "." : relativePath);
		},
		async directoryExists(relativePath) {
			return directories.has(relativePath === "." ? "." : relativePath);
		},
	};
}

const NPM_PROJECT = {
	"package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { leftpad: "^1.0.0" } }),
	"package-lock.json": "{ lockfileVersion: 3 }",
};

describe("detectInstallUnits", () => {
	it("finds the root npm unit with its manifest and lockfile as inputs", async () => {
		const result = await detectInstallUnits(createMemoryReader(NPM_PROJECT));
		expect(result.units).toHaveLength(1);
		const [unit] = result.units;
		expect(unit?.installPath).toBe(".");
		expect(unit?.packageManager).toBe("npm");
		expect(unit?.lockfiles).toEqual(["package-lock.json"]);
		expect(unit?.inputs.map((input) => input.path)).toEqual(["package-lock.json", "package.json"]);
	});

	it("returns nothing for a checkout without a manifest", async () => {
		const result = await detectInstallUnits(createMemoryReader({ "README.md": "# hi" }));
		expect(result.units).toEqual([]);
	});

	it("treats independently installed nested projects as their own units", async () => {
		// Kanban's own shape: a root install plus web-ui and packages/desktop.
		const reader = createMemoryReader({
			...NPM_PROJECT,
			"web-ui/package.json": JSON.stringify({ name: "web", version: "1.0.0" }),
			"web-ui/package-lock.json": "{ lockfileVersion: 3 }",
			"packages/desktop/package.json": JSON.stringify({ name: "desktop", version: "1.0.0" }),
			"packages/desktop/package-lock.json": "{ lockfileVersion: 3 }",
		});
		const result = await detectInstallUnits(reader);
		expect(result.units.map((unit) => unit.installPath)).toEqual([".", "packages/desktop", "web-ui"]);
		expect(result.units[2]?.lockfiles).toEqual(["web-ui/package-lock.json"]);
		// The root install does not absorb a nested project's lockfile.
		expect(result.units[0]?.inputs.map((input) => input.path)).toEqual(["package-lock.json", "package.json"]);
	});

	it("keeps workspace members inside the root install instead of splitting them out", async () => {
		const reader = createMemoryReader({
			"package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
			"package-lock.json": "{ lockfileVersion: 3 }",
			"packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
			"packages/b/package.json": JSON.stringify({ name: "b", version: "1.0.0" }),
			"tools/cli/package.json": JSON.stringify({ name: "cli", version: "1.0.0" }),
			"tools/cli/yarn.lock": "# yarn lockfile v1\n",
		});
		const result = await detectInstallUnits(reader);
		expect(result.units.map((unit) => unit.installPath)).toEqual([".", "tools/cli"]);
		const rootInputs = result.units[0]?.inputs.map((input) => input.path);
		expect(rootInputs).toContain("packages/a/package.json");
		expect(rootInputs).toContain("packages/b/package.json");
		expect(rootInputs).not.toContain("tools/cli/package.json");
	});

	it("honors pnpm workspace files", async () => {
		const reader = createMemoryReader({
			"package.json": JSON.stringify({ name: "mono", packageManager: "pnpm@9.1.0" }),
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
		});
		const result = await detectInstallUnits(reader);
		expect(result.units).toHaveLength(1);
		expect(result.units[0]?.packageManager).toBe("pnpm");
		expect(result.units[0]?.inputs.map((input) => input.path)).toEqual([
			"package.json",
			"packages/a/package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
		]);
	});

	it("separates yarn classic from yarn berry", async () => {
		const classic = await detectInstallUnits(
			createMemoryReader({
				"package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
				"yarn.lock": "# yarn lockfile v1\n\nleft-pad@^1.0.0:\n  version 1.3.0\n",
			}),
		);
		expect(classic.units[0]?.packageManager).toBe("yarn");

		const berry = await detectInstallUnits(
			createMemoryReader({
				"package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
				"yarn.lock": "# This file is generated by Yarn.\n__metadata:\n  version: 8\n",
			}),
		);
		expect(berry.units[0]?.packageManager).toBe("yarn-berry");

		const declared = await detectInstallUnits(
			createMemoryReader({
				"package.json": JSON.stringify({ name: "app", version: "1.0.0", packageManager: "yarn@3.6.0" }),
				"package-lock.json": "{ lockfileVersion: 3 }",
			}),
		);
		// An explicit corepack field outranks a stray npm lockfile.
		expect(declared.units[0]?.packageManager).toBe("yarn-berry");
	});

	it("prefers bun and pnpm lockfiles over the npm default", async () => {
		const bun = await detectInstallUnits(
			createMemoryReader({
				"package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
				"bun.lockb": "binary",
				"package-lock.json": "{ lockfileVersion: 3 }",
			}),
		);
		expect(bun.units[0]?.packageManager).toBe("bun");
		const pnpm = await detectInstallUnits(
			createMemoryReader({
				"package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
				"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
				"yarn.lock": "# yarn lockfile v1\n",
			}),
		);
		expect(pnpm.units[0]?.packageManager).toBe("pnpm");
	});

	it("ignores nested projects that own no lockfile", async () => {
		const reader = createMemoryReader({
			...NPM_PROJECT,
			"docs/package.json": JSON.stringify({ name: "docs", version: "1.0.0" }),
		});
		const result = await detectInstallUnits(reader);
		expect(result.units.map((unit) => unit.installPath)).toEqual(["."]);
	});
});

describe("discoverInstallUnitOutputs", () => {
	it("finds a nested project's tree but never a nested unit's own tree", async () => {
		const reader = createMemoryReader(
			{
				...NPM_PROJECT,
				"web-ui/package.json": JSON.stringify({ name: "web", version: "1.0.0" }),
				"web-ui/package-lock.json": "{ lockfileVersion: 3 }",
			},
			["node_modules", "web-ui/node_modules", "packages/tool/node_modules"],
		);
		const rootOutputs = await discoverInstallUnitOutputs(reader, ".", ["web-ui"]);
		expect(rootOutputs).toEqual(["node_modules", "packages/tool/node_modules"]);
		expect(await discoverInstallUnitOutputs(reader, "web-ui", ["."])).toEqual(["web-ui/node_modules"]);
	});
});

describe("workspace pattern parsing", () => {
	it("parses the pnpm packages list and ignores other keys", () => {
		expect(
			parsePnpmWorkspacePatterns(
				["packages:", "  - 'packages/*'", '  - "apps/*"', "", "# trailing comment", "other: value"].join("\n"),
			),
		).toEqual(["packages/*", "apps/*"]);
		expect(parsePnpmWorkspacePatterns(null)).toEqual([]);
	});

	it("matches exact paths, wildcards and negations", () => {
		expect(matchesWorkspacePattern("packages/*", "packages/a")).toBe(true);
		expect(matchesWorkspacePattern("packages/*", "packages/a/nested")).toBe(false);
		expect(matchesWorkspacePattern("packages/*/helper", "packages/a/helper")).toBe(true);
		expect(matchesWorkspacePattern("!packages/secret", "packages/secret")).toBe(true);
		expect(matchesWorkspacePattern(".", ".")).toBe(false);
	});
});

describe("parseDeclaredPackageManager", () => {
	it("reads corepack declarations", () => {
		expect(parseDeclaredPackageManager("pnpm@9.1.0+sha512.abc")).toBe("pnpm");
		expect(parseDeclaredPackageManager("yarn@1.22.19")).toBe("yarn");
		expect(parseDeclaredPackageManager("yarn@4.0.0")).toBe("yarn-berry");
		expect(parseDeclaredPackageManager("bun@1.1.0")).toBe("bun");
		expect(parseDeclaredPackageManager("")).toBeNull();
		expect(parseDeclaredPackageManager("deno@2")).toBeNull();
	});
});

describe("computeInstallFingerprint", () => {
	const inputs = [
		{ path: "package.json", content: '{"name":"app"}' },
		{ path: "package-lock.json", content: "{ lockfileVersion: 3 }" },
	];

	it("is stable for identical inputs and independent of their order", () => {
		const first = computeInstallFingerprint({
			installPath: ".",
			packageManager: "npm",
			inputs,
			environment: "linux-x64-node22",
		});
		const second = computeInstallFingerprint({
			installPath: ".",
			packageManager: "npm",
			inputs: [...inputs].reverse(),
			environment: "linux-x64-node22",
		});
		expect(first.key).toBe(second.key);
		expect(first.key).toMatch(/^root__npm__linux-x64-node22__[0-9a-f]{24}$/);
	});

	it("changes when any install input changes", () => {
		const base = computeInstallFingerprint({
			installPath: ".",
			packageManager: "npm",
			inputs,
			environment: "linux-x64-node22",
		});
		const bumped = computeInstallFingerprint({
			installPath: ".",
			packageManager: "npm",
			inputs: [
				{ path: "package.json", content: '{"name":"app"}' },
				{ path: "package-lock.json", content: "{ lockfileVersion: 3, packages: {} }" },
			],
			environment: "linux-x64-node22",
		});
		expect(bumped.key).not.toBe(base.key);
	});

	it("separates install scope, package manager and environment", () => {
		const base = computeInstallFingerprint({
			installPath: ".",
			packageManager: "npm",
			inputs,
			environment: "linux-x64-node22",
		});
		expect(
			computeInstallFingerprint({
				installPath: "web-ui",
				packageManager: "npm",
				inputs,
				environment: "linux-x64-node22",
			}).key,
		).not.toBe(base.key);
		expect(
			computeInstallFingerprint({
				installPath: ".",
				packageManager: "pnpm",
				inputs,
				environment: "linux-x64-node22",
			}).key,
		).not.toBe(base.key);
		expect(
			computeInstallFingerprint({
				installPath: ".",
				packageManager: "npm",
				inputs,
				environment: "darwin-arm64-node24",
			}).key,
		).not.toBe(base.key);
	});

	it("describes the running environment at Node major granularity", () => {
		expect(computeEnvironmentSignature({ platform: "linux", arch: "x64", nodeVersion: "v22.14.0" })).toBe(
			"linux-x64-node22",
		);
		expect(computeEnvironmentSignature({ platform: "win32", arch: "x64", nodeVersion: "v20.1.0" })).toBe(
			"win32-x64-node20",
		);
	});
});

describe("buildInstallPlan", () => {
	it("never writes a lockfile the repository does not track", () => {
		expect(buildInstallPlan({ packageManager: "npm", hasLockfile: true }).args.slice(0, 2)).toEqual([
			"ci",
			"--no-audit",
		]);
		expect(buildInstallPlan({ packageManager: "npm", hasLockfile: false }).args).toContain("--no-package-lock");
		expect(buildInstallPlan({ packageManager: "pnpm", hasLockfile: false }).args).toContain("--lockfile=false");
		expect(buildInstallPlan({ packageManager: "yarn", hasLockfile: false }).args).toContain("--no-lockfile");
	});

	it("uses frozen resolution per package manager", () => {
		expect(buildInstallPlan({ packageManager: "npm", hasLockfile: true }).args).toEqual([
			"ci",
			"--no-audit",
			"--no-fund",
			"--prefer-offline",
		]);
		expect(buildInstallPlan({ packageManager: "pnpm", hasLockfile: true }).args).toContain("--frozen-lockfile");
		expect(buildInstallPlan({ packageManager: "yarn", hasLockfile: true }).args).toContain("--frozen-lockfile");
		expect(buildInstallPlan({ packageManager: "yarn-berry", hasLockfile: true }).args).toEqual([
			"install",
			"--immutable",
		]);
		expect(buildInstallPlan({ packageManager: "bun", hasLockfile: true }).args).toEqual([
			"install",
			"--frozen-lockfile",
		]);
	});

	it("keeps corepack and husky from rewriting the task checkout", () => {
		const plan = buildInstallPlan({ packageManager: "npm", hasLockfile: true });
		expect(plan.env.COREPACK_ENABLE_AUTO_PIN).toBe("0");
		expect(plan.env.HUSKY).toBe("0");
		expect(plan.command).toBe("npm");
	});
});

describe("findExecutableOnPath", () => {
	it("scans PATH without spawning a shell", async () => {
		const found = await findExecutableOnPath(
			"pnpm",
			{ PATH: "/a:/b/usr/local/bin" },
			async (candidate) => candidate === "/b/usr/local/bin/pnpm",
		);
		expect(found).toBe("/b/usr/local/bin/pnpm");
		expect(await findExecutableOnPath("bun", { PATH: "/a" }, async () => false)).toBeNull();
	});
});

describe("resolveTransferStrategy", () => {
	it("defaults to the cheap link strategy and honors the opt-out", () => {
		expect(resolveTransferStrategy({ env: {} })).toBe("link");
		expect(resolveTransferStrategy({ env: { KANBAN_WORKTREE_DEPS_STRATEGY: "COPY" } })).toBe("copy");
		expect(resolveTransferStrategy({ env: { KANBAN_WORKTREE_DEPS_STRATEGY: "nonsense" } })).toBe("link");
		expect(resolveTransferStrategy({ strategy: "copy", env: { KANBAN_WORKTREE_DEPS_STRATEGY: "link" } })).toBe(
			"copy",
		);
	});
});
