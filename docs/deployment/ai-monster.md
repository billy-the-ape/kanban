# Deploying Kanban with GitHub Actions

The repository includes a **Deploy Kanban to ai-monster** workflow. Every push to main deploys that exact pushed commit automatically. It also supports a manual run with a full, immutable 40-character commit SHA. In either case it installs every lockfile, builds the revision, runs the same checks as CI, and invokes a fixed host helper to create and activate a release. A failed post-restart health check restores the previous systemd override.

## One-time host preparation

1. Register the self-hosted runner for this repository with these labels: self-hosted, linux, x64, and monster.
2. Install ops/ai-monster/kanban-deploy-release as /usr/local/sbin/kanban-deploy-release, owned by root and mode 0755.
3. Grant the account that runs the GitHub Actions runner passwordless access to that helper only. Do not grant unrestricted passwordless sudo. Identify the runner account from its service configuration before adding the narrowly scoped sudoers entry.
4. Create the GitHub Environment named kanban-production and restrict it to the main branch. Do not configure required reviewers if deployments are meant to be unattended; required reviewers pause every main push before the runner starts.
5. Ensure the existing cline-kanban.service retains its original npm-based command as its base unit. The helper writes a drop-in that selects the current immutable release, so removing that drop-in and restarting the service remains a rollback path.

The helper needs the existing service name, loopback health endpoint, and release directory layout. These are deliberately fixed in the root-owned helper, not supplied by workflow inputs.

## Automatic and manual deployment

Every push to main starts a deployment of that pushed commit. The workflow uses the push event SHA, so it cannot silently deploy a newer main revision.

For a recovery or repeat deployment, open Actions → Deploy Kanban to ai-monster → Run workflow and paste a full commit SHA from main.

A successful run reports the deployed commit. A failure before the release switch leaves the current service untouched. A failure after the switch restores the preceding drop-in and restarts the service; the failed release remains on disk for inspection.

## Verification

The workflow runs lockfile installs, the production build, linting, type checks, root tests, web UI tests, desktop type checks, and desktop tests. After the helper returns, it verifies that cline-kanban.service is active and the loopback HTTP endpoint responds.

## Operational boundaries

This workflow intentionally does not run for pull requests. It runs only after a commit reaches main, plus explicit manual recovery runs. Repository workflow concurrency prevents two Kanban deployments from overlapping; the host helper also takes a host-level lock so the release switch cannot overlap with another caller.
