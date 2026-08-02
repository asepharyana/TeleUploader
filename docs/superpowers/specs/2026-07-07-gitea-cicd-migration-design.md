# Gitea Remote and CI/CD Migration Design

> Catatan (2026-08-02): Produksi sekarang port 4000, deploy Nix+systemd di orangevps, Caddy reverse proxy upload.asepharyana.my.id, DB via pgbouncer pool imrnes 100.121.180.82:6432. Docker/Traefik/Gitea-CI legacy.

## Goal

Move the repository origin from GitLab to a new Gitea repository and add a Gitea Actions deployment flow that behaves like a GitHub Actions CI/CD pipeline.

Target repository:

- Gitea instance: `git.imrnes.team`
- Owner: `MythEclipse`
- Repository: `TeleUploader`
- SSH remote: `git@git.imrnes.team:MythEclipse/TeleUploader.git`

Deployment should run automatically on pushes to `main`.

## Current State

- Current `origin` points to GitLab: `git@gitlab.com:superaseph/TeleUploader.git`.
- There is no existing `.github/workflows` or `.gitea/workflows` directory.
- `deploy.sh` already implements the production deploy path:
  1. Install dependencies.
  2. Format/lint/build with Bun.
  3. Ship the deploy context to the VPS with an SSH tar pipe.
  4. Build and restart the Docker Compose service on the VPS.
  5. Print container status/logs.
- `deploy.sh` still contains GitLab-specific CI variable lookup through `glab`.

## Recommended Approach

Use `deploy.sh` as the single deploy entrypoint and add a thin Gitea Actions wrapper around it.

This keeps local and CI deployment behavior consistent while moving secret storage and automation from GitLab to Gitea.

## Scope

In scope:

1. Create the Gitea repository with `tea` if it does not already exist.
2. Change `origin` to the new Gitea SSH URL.
3. Add `.gitea/workflows/deploy.yml`.
4. Make `deploy.sh` provider-neutral by removing GitLab/glab dependency.
5. Configure required Gitea Actions secrets/variables where supported by `tea`.
6. Push `main` to Gitea after user approval.

Out of scope:

- Rewriting the deploy flow into YAML-only SSH commands.
- Changing VPS Docker Compose architecture.
- Changing app runtime configuration or production domains.
- Adding a new Gitea runner. The design assumes a working runner exists for the Gitea instance.

## Workflow Behavior

The Gitea workflow should run on pushes to `main`:

```yaml
on:
  push:
    branches:
      - main
```

The workflow job should:

1. Check out the repository.
2. Set up Bun in the runner environment.
3. Run `bun install`.
4. Run `bun run lint`.
5. Run `bun run build`.
6. Write the SSH private key from a Gitea Actions secret to a temporary file.
7. Export deploy environment variables.
8. Run `./deploy.sh --no-build`.

`--no-build` avoids duplicate build work because the workflow already runs lint/build before deployment.

## CI Gate

The deployment gate is `lint + build` only.

Tests are intentionally excluded from the automatic deploy gate because this repository has tests that can rely on network, database, or mock isolation constraints. Specific tests can still be run manually when needed.

## Required Gitea Actions Configuration

Required secret:

- `VPS_SSH_KEY`: private SSH key used by the workflow to connect to the VPS.

Required variable or secret:

- `VPS_HOST`: VPS hostname or IP.
- `VPS_USER`: SSH username, expected to be `root` unless changed.

The workflow can read `VPS_HOST` and `VPS_USER` from variables if Gitea Actions variables are enabled. If not, store them as secrets as well.

## `deploy.sh` Changes

`deploy.sh` should no longer require GitLab or `glab`.

Changes:

1. Remove `GITLAB_PROJECT`.
2. Remove `fetch_ci_var()`.
3. Update comments from GitLab CI vars to Gitea Actions secrets/variables or direct environment variables.
4. Keep local defaults:
   - `VPS_HOST=45.127.35.244`
   - `VPS_USER=root`
   - `VPS_SSH_KEY=$HOME/.ssh/id_ed25519`
5. Preserve existing flags:
   - `--no-build`
   - `--check`
   - `--help`
6. Preserve the existing deploy mechanism and health/status reporting.

This keeps local `./deploy.sh` usage working while allowing Gitea Actions to inject CI credentials.

## Repository Setup Commands

Expected implementation commands after approval:

```sh
tea repos create --owner MythEclipse --name TeleUploader --private
```

If the repository already exists, skip creation and use the existing remote.

Then:

```sh
git remote set-url origin git@git.imrnes.team:MythEclipse/TeleUploader.git
git push -u origin main
```

Before pushing, verify the local diff and ask for explicit approval if there are uncommitted changes that should be included.

## Secret Setup Commands

Use `tea` where possible:

```sh
tea actions secrets create VPS_SSH_KEY
tea actions variables set VPS_HOST 45.127.35.244
tea actions variables set VPS_USER root
```

If `tea actions variables` is unsupported by the instance, use secrets for all three values.

Secrets that require interactive input may need the user to run the command with `!` in Claude Code so the prompt is visible in this session.

## Error Handling

- If `tea repos create` reports the repo already exists, continue by verifying repository details and setting the remote.
- If `tea` is not authenticated correctly, stop and ask the user to run `! tea login add`.
- If Gitea Actions variables are unavailable, fall back to repository secrets.
- If no Gitea runner is available, repository migration can still complete, but deployment will not run until a runner is registered.
- If `git push` fails due to SSH permissions, stop and report the exact failure.

## Verification

Before considering the migration ready:

1. Run `./deploy.sh --check` locally to confirm deployment inputs resolve.
2. Run `bun run lint`.
3. Run `bun run build`.
4. Verify `git remote -v` points to `git@git.imrnes.team:MythEclipse/TeleUploader.git`.
5. Verify `.gitea/workflows/deploy.yml` exists.
6. After push, verify Gitea can see the repository and Actions workflow.

## Open Operational Assumptions

- Gitea Actions is enabled on `git.imrnes.team`.
- A runner capable of running Bun, SSH, tar, and shell commands is available.
- The workflow runner can reach the VPS over SSH.
- The deployment SSH key is authorized on the VPS.
