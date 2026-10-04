# Test Layout

- `test/core`: unit tests for core logic
- `test/cli`: unit tests for CLI parsing and output
- `test/integration`: integration tests that touch filesystem or process boundaries
- `test/fixtures`: stable test data
- `test/utilities`: shared test helpers

Use `*.test.ts` for deterministic unit tests. Use `*.integration.test.ts` for optional env-dependent tests.

## Environment isolation

The root Vitest config uses `test/environment.ts`, a Node environment that removes
inherited `GIT_*` routing and configuration variables before test modules load.
Each test file gets a temporary HOME/USERPROFILE, Cline storage and log path, and
XDG/Windows user storage paths. System Git config is disabled. All suite teardown
hooks run before the environment restores inherited values and removes its files.
This applies to root test commands, including manual `npm test` and
`npm run test:fast`; no host configuration or Git hook is required.

Use `createGitTestEnv()` for fixture Git subprocesses as an additional safeguard,
especially in suites that intentionally change environment variables. Keep any
suite-specific temporary HOME or CLINE_DIR overrides and restore them in teardown.
The web UI and desktop have separate Vitest configs; this environment applies to
the root Node suites. It isolates inherited state, rather than sandboxing arbitrary
commands or hard-coded filesystem paths.

Run `npx vitest run test/utilities/test-environment.test.ts` for the linked-worktree
contamination regression and `npm run test:fast` for the runtime suite.
