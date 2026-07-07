import { expect, test } from 'bun:test';

const repoRoot = new URL('../', import.meta.url);
const deployScript = Bun.file(new URL('../deploy.sh', import.meta.url));

test('deploy script is provider-neutral', async () => {
  const text = await deployScript.text();

  expect(text).not.toContain('GITLAB_PROJECT');
  expect(text).not.toContain('fetch_ci_var');
  expect(text).not.toContain('glab');
  expect(text).not.toContain('GitLab CI');
  expect(text).toContain('Gitea Actions secrets');
});

test('deploy check mode does not require an SSH key file', async () => {
  const proc = Bun.spawn(['bash', 'deploy.sh', '--check'], {
    cwd: repoRoot.pathname,
    env: {
      ...Bun.env,
      VPS_HOST: '203.0.113.10',
      VPS_USER: 'deploy',
      VPS_SSH_KEY: '/tmp/nonexistent-teleuploader-key',
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain('App name:');
  expect(stdout).toContain('VPS_HOST:');
  expect(stdout).toContain('VPS_USER:');
  expect(stdout).toContain('VPS_SSH_KEY:');
  expect(stderr).toBe('');
});

const workflowFile = Bun.file(new URL('../.gitea/workflows/deploy.yml', import.meta.url));

test('gitea workflow deploys pushes to main through deploy script', async () => {
  const text = await workflowFile.text();

  expect(text).toContain('name: Deploy FileDrop');
  expect(text).toContain('branches:\n      - main');
  expect(text).toContain('uses: actions/checkout@v4');
  expect(text).toContain('uses: oven-sh/setup-bun@v2');
  expect(text).toContain('bun install --frozen-lockfile');
  expect(text).toContain('bun run lint');
  expect(text).toContain('bun run build');
  expect(text).toContain('secrets.VPS_HOST');
  expect(text).toContain('secrets.VPS_USER');
  expect(text).toContain('secrets.VPS_SSH_KEY');
  expect(text).toContain('secrets.PRODUCTION_ENV');
  expect(text).toContain('./deploy.sh --no-build');
});
