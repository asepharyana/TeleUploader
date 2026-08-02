# Gitea CI/CD Migration Implementation Plan

> Catatan (2026-08-02): Produksi sekarang port 4000, deploy Nix+systemd di orangevps, Caddy reverse proxy upload.asepharyana.my.id, DB via pgbouncer pool imrnes 100.121.180.82:6432. Docker/Traefik/Gitea-CI legacy.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `origin` from GitLab to `git.imrnes.team:MythEclipse/TeleUploader` and add Gitea Actions deployment on push to `main` using the existing VPS deploy path.

**Architecture:** Keep `deploy.sh` as the single deployment entrypoint and make it provider-neutral. Add a thin `.gitea/workflows/deploy.yml` wrapper that performs the CI gate (`bun install`, `bun run lint`, `bun run build`), reconstructs runtime secrets into files, then calls `./deploy.sh --no-build`.

**Tech Stack:** Bun, Bun test, Biome, Bash, Docker Compose on VPS, Gitea Actions, `tea` CLI, SSH.

## Global Constraints

- Default to Bun commands: use `bun install`, `bun run lint`, `bun run build`, and `bun test`.
- Do not use Node.js, npm, yarn, pnpm, vite, webpack, or Express for this work.
- Deployment target repository is `MythEclipse/TeleUploader` on `git.imrnes.team`.
- Target SSH remote is `git@git.imrnes.team:MythEclipse/TeleUploader.git`.
- Gitea Actions deployment trigger is push to `main`.
- Automatic deploy gate is lint + build only; do not add full test suite execution to the deploy workflow.
- Preserve the existing VPS deployment mechanism: SSH tar pipe, remote Docker Compose build, and container restart.
- Do not commit unless the user explicitly authorizes commits during execution.
- Do not push unless the user explicitly authorizes pushing during execution.
- Never commit `.env`; reconstruct it in Gitea Actions from a repository secret named `PRODUCTION_ENV`.

---

## File Structure

- Modify: `deploy.sh`
  - Responsibility: local and CI deployment entrypoint. It must no longer know about GitLab or `glab`; it should read deployment inputs from environment variables or local defaults.
- Create: `.gitea/workflows/deploy.yml`
  - Responsibility: Gitea Actions CI/CD wrapper. It runs lint/build, writes CI secrets into temporary files, and calls `deploy.sh --no-build`.
- Create/modify: `test/deploy-config.test.ts`
  - Responsibility: fast static and dry-run coverage for deployment configuration. It prevents regressions to GitLab-specific deploy logic and verifies the workflow invokes the expected deploy path.
- External state: Gitea repository `MythEclipse/TeleUploader`
  - Responsibility: new git origin and Gitea Actions secret storage. Manage with `tea` only after code/config changes are reviewed.

---

### Task 1: Make `deploy.sh` Provider-Neutral

**Files:**
- Create: `test/deploy-config.test.ts`
- Modify: `deploy.sh`

**Interfaces:**
- Consumes: existing `deploy.sh --check`, `deploy.sh --no-build`, and Bun scripts from `package.json`.
- Produces: provider-neutral `deploy.sh` that accepts these environment variables:
  - `VPS_HOST: string`
  - `VPS_USER: string`
  - `VPS_SSH_KEY: string` path to an SSH private key file
  - optional `DEPLOY_DIR: string`
  - optional `ADMIN_PASSWORD: string`

- [ ] **Step 1: Write the failing deploy configuration tests**

Create `test/deploy-config.test.ts` with this exact content:

```ts
import { expect, test } from "bun:test";

const repoRoot = new URL("../", import.meta.url);
const deployScript = Bun.file(new URL("../deploy.sh", import.meta.url));

test("deploy script is provider-neutral", async () => {
  const text = await deployScript.text();

  expect(text).not.toContain("GITLAB_PROJECT");
  expect(text).not.toContain("fetch_ci_var");
  expect(text).not.toContain("glab");
  expect(text).not.toContain("GitLab CI");
  expect(text).toContain("Gitea Actions secrets");
});

test("deploy check mode does not require an SSH key file", async () => {
  const proc = Bun.spawn(["bash", "deploy.sh", "--check"], {
    cwd: repoRoot.pathname,
    env: {
      ...Bun.env,
      VPS_HOST: "203.0.113.10",
      VPS_USER: "deploy",
      VPS_SSH_KEY: "/tmp/nonexistent-teleuploader-key",
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("App name:");
  expect(stdout).toContain("VPS_HOST:");
  expect(stdout).toContain("VPS_USER:");
  expect(stdout).toContain("VPS_SSH_KEY:");
  expect(stderr).toBe("");
});
```

- [ ] **Step 2: Run the new test and verify the expected failure**

Run:

```bash
bun test test/deploy-config.test.ts
```

Expected result: FAIL in `deploy script is provider-neutral` because the current `deploy.sh` still contains at least `GITLAB_PROJECT`, `fetch_ci_var`, `glab`, or `GitLab CI`.

- [ ] **Step 3: Update the `deploy.sh` header comments**

In `deploy.sh`, replace the prerequisite and environment comment block near the top with this exact text:

```bash
# Prerequisites:
#   - SSH access to the VPS
#   - Docker + docker compose on the VPS
#   - For CI: Gitea Actions secrets injected as environment variables
#
# Usage:
#   ./deploy.sh                          # build + deploy
#   ./deploy.sh --no-build               # skip build, just deploy dist
#   ./deploy.sh --help                   # show this message
#   ./deploy.sh --check                  # dry-run: show vars and exit
#
# Required env in CI:
#   VPS_HOST              — VPS IP/hostname
#   VPS_USER              — SSH user
#   VPS_SSH_KEY           — path to SSH private key file
#
# Local defaults:
#   VPS_HOST              — 45.127.35.244
#   VPS_USER              — root
#   VPS_SSH_KEY           — ~/.ssh/id_ed25519
#
# Optional:
#   DEPLOY_DIR            — deploy dir on VPS (default: /opt/filedrop)
#   ADMIN_PASSWORD        — verify health after deploy (optional)
```

- [ ] **Step 4: Remove GitLab-specific configuration**

In `deploy.sh`, replace this config block:

```bash
APP_NAME="filedrop"
GITLAB_PROJECT="superaseph%2FTeleUploader"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/${APP_NAME}}"
COMPOSE_FILE="docker-compose.yml"
DOCKER_IMAGE="ghcr.io/mytheclipse/${APP_NAME}"
```

with this exact block:

```bash
APP_NAME="filedrop"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/${APP_NAME}}"
COMPOSE_FILE="docker-compose.yml"
DOCKER_IMAGE="ghcr.io/mytheclipse/${APP_NAME}"
```

- [ ] **Step 5: Remove GitLab CI variable fetching**

Delete this entire block from `deploy.sh`:

```bash
# ── Auto-fetch credentials from GitLab CI vars ─────────────────────────────
fetch_ci_var() {
  glab api "projects/${GITLAB_PROJECT}/variables/$1" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('value',''))" 2>/dev/null || true
}
```

Then replace the default credential block with this exact text:

```bash
# ── Default credentials ─────────────────────────────────────────────────────
# Local defaults for this project. CI-provided environment variables take precedence.
: "${VPS_HOST:=45.127.35.244}"
: "${VPS_USER:=root}"
: "${VPS_SSH_KEY:=${HOME}/.ssh/id_ed25519}"
```

Delete this entire fallback block:

```bash
# Fallback: fetch from GitLab CI vars if defaults are empty (for CI runs)
if [ -z "${VPS_HOST:-}" ]; then VPS_HOST=$(fetch_ci_var VPS_HOST); fi
if [ -z "${VPS_USER:-}" ]; then VPS_USER=$(fetch_ci_var VPS_USERNAME); fi
if [ -z "${VPS_SSH_KEY:-}" ]; then
  KEY=$(fetch_ci_var VPS_SSH_KEY)
  if [ -n "$KEY" ]; then
    VPS_SSH_KEY=$(mktemp)
    echo "$KEY" > "$VPS_SSH_KEY"
    chmod 600 "$VPS_SSH_KEY"
  fi
fi
```

- [ ] **Step 6: Move helper functions before validation**

In `deploy.sh`, ensure this helper block appears before the validation block that calls `die`:

```bash
# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "→ $*"; }
ok()   { echo "✓ $*"; }
die()  { echo "✗ $*"; exit 1; }
```

After validation, keep these lines together:

```bash
SSH_DEST="${VPS_USER}@${VPS_HOST}"
SSH_OPTS="-i $VPS_SSH_KEY -o StrictHostKeyChecking=accept-new"

vps()  { ssh $SSH_OPTS "$SSH_DEST" "$@"; }
```

The validation block must remain:

```bash
# ── Validate ──────────────────────────────────────────────────────────────────
# (Defaults are set above — this fails only if something went wrong)
: "${VPS_HOST:?VPS_HOST resolved to empty}"
: "${VPS_USER:?VPS_USER resolved to empty}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY resolved to empty}"
[ -f "$VPS_SSH_KEY" ] || die "SSH key not found at $VPS_SSH_KEY"
```

- [ ] **Step 7: Run the focused deploy config test**

Run:

```bash
bun test test/deploy-config.test.ts
```

Expected result: PASS, 2 tests passing.

- [ ] **Step 8: Run deploy check mode manually**

Run:

```bash
./deploy.sh --check
```

Expected result: exits 0 and prints `=== Config ===`, `=== Credentials ===`, and `=== Files to deploy ===`. It may mark files as missing only if local build artifacts are not present yet.

- [ ] **Step 9: Review diff**

Run:

```bash
git diff -- deploy.sh test/deploy-config.test.ts
```

Expected result: diff only removes GitLab/glab awareness from `deploy.sh` and adds the new deploy config tests.

- [ ] **Step 10: Commit only if authorized**

Ask the user: `May I commit Task 1 changes?`

If the user says yes, run:

```bash
git add deploy.sh test/deploy-config.test.ts
git commit -m "chore: make deploy script provider-neutral"
```

If the user says no, do not commit; leave the changes in the working tree and continue only if the user wants inline uncommitted execution.

---

### Task 2: Add Gitea Actions Deploy Workflow

**Files:**
- Modify: `test/deploy-config.test.ts`
- Create: `.gitea/workflows/deploy.yml`

**Interfaces:**
- Consumes: provider-neutral `deploy.sh --no-build` from Task 1.
- Produces: workflow `.gitea/workflows/deploy.yml` that requires these repository secrets:
  - `VPS_HOST`
  - `VPS_USER`
  - `VPS_SSH_KEY`
  - `PRODUCTION_ENV`
  - optional `ADMIN_PASSWORD`

- [ ] **Step 1: Extend deploy config tests for the Gitea workflow**

Append this exact code to `test/deploy-config.test.ts`:

```ts
const workflowFile = Bun.file(new URL("../.gitea/workflows/deploy.yml", import.meta.url));

test("gitea workflow deploys pushes to main through deploy script", async () => {
  const text = await workflowFile.text();

  expect(text).toContain("name: Deploy FileDrop");
  expect(text).toContain("branches:\n      - main");
  expect(text).toContain("uses: actions/checkout@v4");
  expect(text).toContain("uses: oven-sh/setup-bun@v2");
  expect(text).toContain("bun install --frozen-lockfile");
  expect(text).toContain("bun run lint");
  expect(text).toContain("bun run build");
  expect(text).toContain("secrets.VPS_HOST");
  expect(text).toContain("secrets.VPS_USER");
  expect(text).toContain("secrets.VPS_SSH_KEY");
  expect(text).toContain("secrets.PRODUCTION_ENV");
  expect(text).toContain("./deploy.sh --no-build");
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
bun test test/deploy-config.test.ts
```

Expected result: FAIL because `.gitea/workflows/deploy.yml` does not exist yet.

- [ ] **Step 3: Create the Gitea Actions workflow**

Create `.gitea/workflows/deploy.yml` with this exact content:

```yaml
name: Deploy FileDrop

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Lint
        run: bun run lint

      - name: Build
        run: bun run build

      - name: Deploy to VPS
        shell: bash
        env:
          VPS_HOST: ${{ secrets.VPS_HOST }}
          VPS_USER: ${{ secrets.VPS_USER }}
          VPS_SSH_KEY_VALUE: ${{ secrets.VPS_SSH_KEY }}
          PRODUCTION_ENV: ${{ secrets.PRODUCTION_ENV }}
          ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
        run: |
          set -eu

          key_file="${RUNNER_TEMP:-/tmp}/filedrop_deploy_key"
          printf '%s\n' "$VPS_SSH_KEY_VALUE" > "$key_file"
          chmod 600 "$key_file"

          printf '%s\n' "$PRODUCTION_ENV" > .env
          chmod 600 .env

          VPS_SSH_KEY="$key_file" ./deploy.sh --no-build
```

- [ ] **Step 4: Run the focused deploy config test**

Run:

```bash
bun test test/deploy-config.test.ts
```

Expected result: PASS, 3 tests passing.

- [ ] **Step 5: Run project lint**

Run:

```bash
bun run lint
```

Expected result: PASS with Biome reporting no errors.

- [ ] **Step 6: Run project build**

Run:

```bash
bun run build
```

Expected result: PASS and creates/updates `dist/index.js` and `dist/migrate.js`.

- [ ] **Step 7: Review diff**

Run:

```bash
git diff -- .gitea/workflows/deploy.yml test/deploy-config.test.ts
```

Expected result: diff adds the workflow and the workflow regression test only.

- [ ] **Step 8: Commit only if authorized**

Ask the user: `May I commit Task 2 changes?`

If the user says yes, run:

```bash
git add .gitea/workflows/deploy.yml test/deploy-config.test.ts
git commit -m "ci: deploy from gitea actions"
```

If the user says no, do not commit; keep the changes in the working tree.

---

### Task 3: Create/Verify Gitea Repository and Configure Secrets

**Files:**
- No repository file changes expected.

**Interfaces:**
- Consumes: `tea` CLI login for `git.imrnes.team`, local `.env`, local SSH key, and Gitea repository `MythEclipse/TeleUploader`.
- Produces: Gitea repository with deploy secrets ready for Actions:
  - `VPS_HOST`
  - `VPS_USER`
  - `VPS_SSH_KEY`
  - `PRODUCTION_ENV`
  - optional `ADMIN_PASSWORD`

- [ ] **Step 1: Verify `tea` identity**

Run:

```bash
tea whoami
```

Expected result: output shows the `MythEclipse` account on `git.imrnes.team`.

If the command says no login is available or uses the wrong instance, stop and ask the user to run:

```bash
! tea login add
```

- [ ] **Step 2: Check whether the target repo already exists**

Run:

```bash
tea repos MythEclipse/TeleUploader
```

Expected result if the repo exists: repository details for `MythEclipse/TeleUploader`.

Expected result if the repo does not exist: a not-found error. Continue to Step 3 only in that case.

- [ ] **Step 3: Create the Gitea repository when missing**

If Step 2 reported that the repo does not exist, run:

```bash
tea repos create --owner MythEclipse --name TeleUploader --private --description "FileDrop Telegram-backed S3-compatible uploader"
```

Expected result: repository `MythEclipse/TeleUploader` is created.

Then verify it:

```bash
tea repos MythEclipse/TeleUploader
```

Expected result: repository details for `MythEclipse/TeleUploader`.

- [ ] **Step 4: Verify local production `.env` exists and is untracked**

Run:

```bash
test -f .env && echo ".env exists"
git ls-files -- .env
```

Expected result: first command prints `.env exists`; second command prints nothing.

If `.env` is missing, stop and ask the user to provide the production environment file before configuring `PRODUCTION_ENV`.

If `git ls-files -- .env` prints `.env`, stop because secrets would be tracked; do not continue until the user decides how to remove it safely.

- [ ] **Step 5: Configure required Gitea Actions secrets**

Run these commands:

```bash
tea actions secrets create --repo MythEclipse/TeleUploader VPS_HOST "45.127.35.244"
tea actions secrets create --repo MythEclipse/TeleUploader VPS_USER "root"
tea actions secrets create --repo MythEclipse/TeleUploader --file "${HOME}/.ssh/id_ed25519" VPS_SSH_KEY
tea actions secrets create --repo MythEclipse/TeleUploader --file .env PRODUCTION_ENV
```

Expected result: each command succeeds.

If `${HOME}/.ssh/id_ed25519` is not the desired deploy key, stop and ask the user for the correct key path before running the `VPS_SSH_KEY` command.

- [ ] **Step 6: Configure optional admin health-check secret when available**

If the local `.env` contains `ADMIN_PASSWORD=`, extract and configure it with:

```bash
admin_password=$(grep '^ADMIN_PASSWORD=' .env | sed 's/^ADMIN_PASSWORD=//')
if [ -n "$admin_password" ]; then
  tea actions secrets create --repo MythEclipse/TeleUploader ADMIN_PASSWORD "$admin_password"
fi
```

Expected result: if `ADMIN_PASSWORD` is present and non-empty, the secret is created. If it is absent or empty, no command is run and the workflow still works because `deploy.sh` treats `ADMIN_PASSWORD` as optional.

- [ ] **Step 7: Verify secret names**

Run:

```bash
tea actions secrets list --repo MythEclipse/TeleUploader
```

Expected result: list includes `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, and `PRODUCTION_ENV`. It may also include `ADMIN_PASSWORD`.

---

### Task 4: Switch Remote, Verify Locally, and Push After Approval

**Files:**
- External git remote configuration only.
- No additional repository file changes expected.

**Interfaces:**
- Consumes: completed Task 1 and Task 2 changes, configured Gitea repository from Task 3.
- Produces: local `origin` set to `git@git.imrnes.team:MythEclipse/TeleUploader.git`, and after explicit approval, `main` pushed to Gitea.

- [ ] **Step 1: Show current status before mutating the remote**

Run:

```bash
git status --short
git remote -v
```

Expected result before remote switch: `origin` still points to `git@gitlab.com:superaseph/TeleUploader.git` unless a prior task already changed it.

- [ ] **Step 2: Set `origin` to Gitea**

Run:

```bash
git remote set-url origin git@git.imrnes.team:MythEclipse/TeleUploader.git
```

- [ ] **Step 3: Verify remote URL**

Run:

```bash
git remote -v
```

Expected result:

```text
origin	git@git.imrnes.team:MythEclipse/TeleUploader.git (fetch)
origin	git@git.imrnes.team:MythEclipse/TeleUploader.git (push)
```

- [ ] **Step 4: Run focused deploy config tests**

Run:

```bash
bun test test/deploy-config.test.ts
```

Expected result: PASS, 3 tests passing.

- [ ] **Step 5: Run lint**

Run:

```bash
bun run lint
```

Expected result: PASS with no Biome errors.

- [ ] **Step 6: Run build**

Run:

```bash
bun run build
```

Expected result: PASS and `dist/index.js` plus `dist/migrate.js` exist.

- [ ] **Step 7: Run deploy dry-run check**

Run:

```bash
./deploy.sh --check
```

Expected result: exits 0 and prints deploy config, credentials, and deploy file presence.

- [ ] **Step 8: Review final diff and status**

Run:

```bash
git status --short
git diff -- deploy.sh test/deploy-config.test.ts .gitea/workflows/deploy.yml docs/superpowers/specs/2026-07-07-gitea-cicd-migration-design.md docs/superpowers/plans/2026-07-07-gitea-cicd-migration.md
```

Expected result: only intended deployment config, workflow, spec, and plan changes appear. `.env` must not appear in `git status --short` as a tracked change.

- [ ] **Step 9: Commit remaining changes only if authorized**

If Task 1 and Task 2 were not committed earlier, ask the user: `May I commit the Gitea CI/CD migration changes?`

If the user says yes, run:

```bash
git add deploy.sh test/deploy-config.test.ts .gitea/workflows/deploy.yml docs/superpowers/specs/2026-07-07-gitea-cicd-migration-design.md docs/superpowers/plans/2026-07-07-gitea-cicd-migration.md
git commit -m "ci: migrate deployment to gitea actions"
```

If there is nothing to commit because earlier task commits already captured the changes, run:

```bash
git status --short
```

Expected result: clean working tree.

- [ ] **Step 10: Ask for explicit push approval**

Ask the user exactly:

```text
Ready to push main to git@git.imrnes.team:MythEclipse/TeleUploader.git. Should I push now?
```

Do not push until the user answers yes.

- [ ] **Step 11: Push `main` to Gitea after approval**

After explicit approval, run:

```bash
git push -u origin main
```

Expected result: push succeeds and branch `main` tracks `origin/main` on Gitea.

- [ ] **Step 12: Verify repository and workflow visibility**

Run:

```bash
tea repos MythEclipse/TeleUploader
tea actions workflows list --repo MythEclipse/TeleUploader
tea actions runs list --repo MythEclipse/TeleUploader
```

Expected result:

- Repository details are visible.
- Workflow list includes `Deploy FileDrop`.
- Runs list shows the push-triggered workflow run, or an empty/pending list if the Gitea runner has not picked it up yet.

If workflow runs are absent because no runner is configured, report that the repo migration and workflow upload are complete but deployment requires a registered Gitea runner.

---

## Self-Review

- Spec coverage: repository creation, remote switch, provider-neutral `deploy.sh`, Gitea workflow, secrets, lint/build verification, and push approval are all mapped to tasks.
- Placeholder scan: no TBD/TODO/fill-in placeholders remain; conditional branches have exact commands and stop conditions.
- Type/command consistency: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `PRODUCTION_ENV`, and `ADMIN_PASSWORD` names are consistent across tests, workflow, `deploy.sh`, and `tea` commands.
