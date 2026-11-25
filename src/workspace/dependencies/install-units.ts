import type { CheckoutReader } from "./checkout-reader";
import { joinCheckoutPath, toCheckoutRelativePath } from "./checkout-reader";
import type { DependencyInputFile, DependencyInstallUnit, WorktreePackageManagerId } from "./types";

export const MANIFEST_FILENAME = "package.json";
export const PNPM_WORKSPACE_FILENAME = "pnpm-workspace.yaml";
export const NPMRC_FILENAME = ".npmrc";
export const YARN_RELEASES_DIR = ".yarn/releases";
export const NODE_MODULES_DIRNAME = "node_modules";

/** Lockfiles in resolution precedence order (the most specific wins). */
const LOCKFILE_CANDIDATES: ReadonlyArray<{ filename: string; packageManager: WorktreePackageManagerId }> = [
	{ filename: "bun.lockb", packageManager: "bun" },
	{ filename: "bun.lock", packageManager: "bun" },
	{ filename: "pnpm-lock.yaml", packageManager: "pnpm" },
	{ filename: "yarn.lock", packageManager: "yarn" },
	{ filename: "package-lock.json", packageManager: "npm" },
	{ filename: "npm-shrinkwrap.json", packageManager: "npm" },
];

/** Directories never scanned for nested projects (build output, caches, VCS). */
const SCAN_DIRECTORY_SKIP = new Set([
	".agent",
	".cache",
	".claude",
	".cline",
	".codex",
	".git",
	".next",
	".nuxt",
	".parcel-cache",
	".pnpm-store",
	".sentry",
	".turbo",
	".venv",
	".yarn",
	".yarn-cache",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"playwright-report",
	"target",
	"test-results",
	"tmp",
	"vendor",
]);

/**
 * Nested projects are found within this many directory levels, matching the
 * scanner used for Turbopack worktree handling so both agree on the shapes
 * Kanban understands.
 */
const SCAN_MAX_DEPTH = 3;

interface PackageJsonShape {
	name?: unknown;
	packageManager?: unknown;
	workspaces?: unknown;
	scripts?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePackageJson(raw: string | null): PackageJsonShape | null {
	if (raw === null) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? (parsed as PackageJsonShape) : null;
	} catch {
		return null;
	}
}

function toWorkspacePatterns(packageJson: PackageJsonShape): string[] {
	const workspaces = packageJson.workspaces;
	if (Array.isArray(workspaces)) {
		return workspaces.filter((pattern): pattern is string => typeof pattern === "string");
	}
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
		return workspaces.packages.filter((pattern): pattern is string => typeof pattern === "string");
	}
	return [];
}

/**
 * Minimal `pnpm-workspace.yaml` reader: only the top-level `packages:` list is
 * understood (`packages:` followed by `- glob` lines). That is the shape pnpm
 * documents; anything else in the file is intentionally ignored.
 */
export function parsePnpmWorkspacePatterns(raw: string | null): string[] {
	if (raw === null) {
		return [];
	}
	const patterns: string[] = [];
	let insidePackagesBlock = false;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const header = /^packages:\s*$/.exec(line);
		if (header !== null) {
			insidePackagesBlock = true;
			continue;
		}
		if (!insidePackagesBlock) {
			continue;
		}
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
			continue;
		}
		// Any non-indented key ends the block.
		if (!/^\s/.test(line)) {
			insidePackagesBlock = false;
			continue;
		}
		const entry = /^\s*-\s*(.*)$/.exec(line);
		if (entry === null) {
			insidePackagesBlock = false;
			continue;
		}
		const pattern = entry[1].trim().replace(/^['"]|['"]$/g, "");
		if (pattern.length > 0) {
			patterns.push(pattern);
		}
	}
	return patterns;
}

/**
 * Matches a workspace pattern against a checkout-relative directory. Supports
 * the shapes real manifests use: an exact path (`web-ui`), a single-segment
 * wildcard as the last segment (`packages` slash star), and `!`-prefixed
 * negations.
 */
export function matchesWorkspacePattern(pattern: string, relativePath: string): boolean {
	const normalizedPattern = toCheckoutRelativePath(pattern.replace(/^!/, ""));
	const normalizedPath = toCheckoutRelativePath(relativePath);
	if (normalizedPattern === "." || normalizedPath === ".") {
		return false;
	}
	const patternSegments = normalizedPattern.split("/");
	const pathSegments = normalizedPath.split("/");
	if (patternSegments.length !== pathSegments.length) {
		return false;
	}
	for (let index = 0; index < patternSegments.length; index += 1) {
		const expected = patternSegments[index];
		if (expected === "*") {
			continue;
		}
		if (expected !== pathSegments[index]) {
			return false;
		}
	}
	return true;
}

function applyPatterns(patterns: string[], relativePath: string): boolean {
	let matched = false;
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			if (matchesWorkspacePattern(pattern, relativePath)) {
				return false;
			}
			continue;
		}
		if (matchesWorkspacePattern(pattern, relativePath)) {
			matched = true;
		}
	}
	return matched;
}

interface PackageManagerResolution {
	packageManager: WorktreePackageManagerId;
	/** Lockfiles present in the install root, in precedence order. */
	lockfiles: string[];
}

function yarnLockIsClassic(lockContent: string | null): boolean {
	if (lockContent === null) {
		return true;
	}
	// Yarn v1 always writes this header; berry lockfiles do not.
	return lockContent.slice(0, 400).includes("# yarn lockfile v1");
}

/**
 * Resolve which package manager owns an install root. An explicit
 * `packageManager` field (corepack) outranks lockfiles, which outrank the
 * npm default. Yarn berry is separated from classic because their install
 * flags differ.
 */
export async function resolvePackageManager(options: {
	directory: string;
	packageJson: PackageJsonShape | null;
	reader: CheckoutReader;
}): Promise<PackageManagerResolution> {
	const { directory, reader } = options;
	const lockfiles: string[] = [];
	for (const candidate of LOCKFILE_CANDIDATES) {
		if ((await reader.readText(joinCheckoutPath(directory, candidate.filename))) !== null) {
			lockfiles.push(candidate.filename);
		}
	}
	const declared =
		typeof options.packageJson?.packageManager === "string" ? options.packageJson.packageManager.trim() : "";
	const declaredId = parseDeclaredPackageManager(declared);
	if (declaredId !== null) {
		return { packageManager: declaredId, lockfiles };
	}
	const first = LOCKFILE_CANDIDATES.find((candidate) => lockfiles.includes(candidate.filename));
	if (first === undefined) {
		return { packageManager: "npm", lockfiles };
	}
	if (first.packageManager === "yarn") {
		const lockContent = await reader.readText(joinCheckoutPath(directory, "yarn.lock"));
		const hasBerryReleases = await reader.directoryExists(joinCheckoutPath(directory, YARN_RELEASES_DIR));
		return {
			packageManager: yarnLockIsClassic(lockContent) && !hasBerryReleases ? "yarn" : "yarn-berry",
			lockfiles,
		};
	}
	return { packageManager: first.packageManager, lockfiles };
}

export function parseDeclaredPackageManager(declared: string): WorktreePackageManagerId | null {
	const match = /^(npm|pnpm|yarn|bun)@(\d+)/.exec(declared.trim());
	if (match === null) {
		return null;
	}
	const major = Number.parseInt(match[2], 10);
	if (Number.isNaN(major) || major < 0) {
		return null;
	}
	if (match[1] === "yarn") {
		return major >= 2 ? "yarn-berry" : "yarn";
	}
	// `packageManager: npm@10` still means npm, even if only a yarn.lock exists.
	const packageManagerId = match[1];
	return packageManagerId === "npm" || packageManagerId === "pnpm" || packageManagerId === "bun"
		? packageManagerId
		: null;
}

export interface DetectInstallUnitsResult {
	units: DependencyInstallUnit[];
	/** Every checkout-relative directory holding a package.json. */
	projectDirectories: string[];
}

async function collectProjectDirectories(reader: CheckoutReader): Promise<string[]> {
	const found: string[] = [];
	const queue: Array<{ directory: string; depth: number }> = [{ directory: ".", depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		const children = await reader.listChildDirectories(current.directory);
		for (const child of children) {
			if (SCAN_DIRECTORY_SKIP.has(child)) {
				continue;
			}
			const childPath = joinCheckoutPath(current.directory, child);
			if ((await reader.readText(joinCheckoutPath(childPath, MANIFEST_FILENAME))) !== null) {
				found.push(childPath);
			}
			if (current.depth + 1 < SCAN_MAX_DEPTH) {
				queue.push({ directory: childPath, depth: current.depth + 1 });
			}
		}
	}
	return found.sort();
}

/** Lockfile paths of an install scope, relative to the checkout root. */
function toLockfilePaths(installPath: string, lockfiles: readonly string[]): string[] {
	return lockfiles.map((lockfile) => joinCheckoutPath(installPath, lockfile));
}

async function readUnitInputs(
	reader: CheckoutReader,
	installPath: string,
	lockfiles: readonly string[],
): Promise<DependencyInputFile[]> {
	const inputs: DependencyInputFile[] = [];
	const push = async (relativePath: string): Promise<void> => {
		const content = await reader.readText(relativePath);
		if (content !== null) {
			inputs.push({ path: toCheckoutRelativePath(relativePath), content });
		}
	};
	await push(joinCheckoutPath(installPath, MANIFEST_FILENAME));
	for (const lockfile of lockfiles) {
		await push(joinCheckoutPath(installPath, lockfile));
	}
	await push(joinCheckoutPath(installPath, PNPM_WORKSPACE_FILENAME));
	await push(joinCheckoutPath(installPath, NPMRC_FILENAME));
	return inputs.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Discover the install units of a checkout, deepest-owned projects last. The
 * repository root is a unit whenever it declares a package.json; a nested
 * project becomes its own unit when it owns a lockfile and is not a workspace
 * member of the root install (Kanban itself is this shape: `web-ui` and
 * `packages/desktop` install independently next to the root install).
 *
 * Nested projects inside a unit are deliberately not split out: the enclosing
 * install owns their resolution, so their trees are captured as part of that
 * unit's outputs.
 */
export async function detectInstallUnits(reader: CheckoutReader): Promise<DetectInstallUnitsResult> {
	const rootManifestRaw = await reader.readText(MANIFEST_FILENAME);
	const rootManifest = parsePackageJson(rootManifestRaw);
	const projectDirectories = await collectProjectDirectories(reader);
	if (rootManifest === null) {
		return { units: [], projectDirectories };
	}

	const root = await resolvePackageManager({ directory: ".", packageJson: rootManifest, reader });
	const rootPatterns = [
		...toWorkspacePatterns(rootManifest),
		...parsePnpmWorkspacePatterns(await reader.readText(PNPM_WORKSPACE_FILENAME)),
	];
	const rootWorkspaceMembers = projectDirectories.filter((directory) => applyPatterns(rootPatterns, directory));

	const units: DependencyInstallUnit[] = [
		{
			installPath: ".",
			packageManager: root.packageManager,
			lockfiles: toLockfilePaths(".", root.lockfiles),
			inputs: await readUnitInputs(reader, ".", root.lockfiles),
		},
	];

	for (const directory of projectDirectories) {
		if (applyPatterns(rootPatterns, directory)) {
			continue;
		}
		if (units.some((unit) => directory !== unit.installPath && directory.startsWith(`${unit.installPath}/`))) {
			continue;
		}
		const manifest = parsePackageJson(await reader.readText(joinCheckoutPath(directory, MANIFEST_FILENAME)));
		if (manifest === null) {
			continue;
		}
		const resolution = await resolvePackageManager({ directory, packageJson: manifest, reader });
		// Without a lockfile of its own the project is not an install scope:
		// nothing would pin it, so it is covered by the enclosing install (or
		// not installed at all, exactly as before this feature existed).
		if (resolution.lockfiles.length === 0) {
			continue;
		}
		units.push({
			installPath: directory,
			packageManager: resolution.packageManager,
			lockfiles: toLockfilePaths(directory, resolution.lockfiles),
			inputs: await readUnitInputs(reader, directory, resolution.lockfiles),
		});
	}

	// Workspace members contribute their manifests to the root install, whose
	// output tree resolves them.
	const rootUnit = units[0];
	for (const member of rootWorkspaceMembers) {
		const manifest = await reader.readText(joinCheckoutPath(member, MANIFEST_FILENAME));
		if (manifest === null) {
			continue;
		}
		if (rootUnit.inputs.some((input) => input.path === joinCheckoutPath(member, MANIFEST_FILENAME))) {
			continue;
		}
		rootUnit.inputs.push({ path: joinCheckoutPath(member, MANIFEST_FILENAME), content: manifest });
	}
	rootUnit.inputs.sort((left, right) => left.path.localeCompare(right.path));

	return {
		units: units.sort((left, right) => left.installPath.localeCompare(right.installPath)),
		projectDirectories,
	};
}

/**
 * Find the `node_modules` directories an install produced for a unit, relative
 * to the checkout root. Nested independent units are excluded because they
 * restore their own trees.
 */
export async function discoverInstallUnitOutputs(
	reader: CheckoutReader,
	installPath: string,
	excludedInstallPaths: readonly string[],
): Promise<string[]> {
	const outputs: string[] = [];
	const isExcluded = (directory: string): boolean =>
		excludedInstallPaths.some(
			(excluded) => excluded !== installPath && (directory === excluded || directory.startsWith(`${excluded}/`)),
		);
	const queue: Array<{ directory: string; depth: number }> = [{ directory: installPath, depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		if (current.directory !== installPath && isExcluded(current.directory)) {
			continue;
		}
		if (await reader.directoryExists(joinCheckoutPath(current.directory, NODE_MODULES_DIRNAME))) {
			outputs.push(joinCheckoutPath(current.directory, NODE_MODULES_DIRNAME));
		}
		if (current.depth >= SCAN_MAX_DEPTH) {
			continue;
		}
		const children = await reader.listChildDirectories(current.directory);
		for (const child of children) {
			if (SCAN_DIRECTORY_SKIP.has(child)) {
				continue;
			}
			const childPath = joinCheckoutPath(current.directory, child);
			if (isExcluded(childPath)) {
				continue;
			}
			queue.push({ directory: childPath, depth: current.depth + 1 });
		}
	}
	return Array.from(new Set(outputs)).sort();
}
