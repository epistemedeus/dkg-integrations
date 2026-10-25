// Run with: node --test --test-concurrency=1 scripts/security-checks.test.mjs
// All checker invocations use disposable files and a fetch replacement. No
// submitted package is installed or executed, and no network request is sent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./security-checks.mjs', import.meta.url));
const npmUrl = (pkg) => `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`;
const npx = (spec, flags = ['-y']) => ({ kind: 'mcp', command: 'npx', args: [...flags, spec] });
const published = (overrides = {}) => ({
  status: 200,
  body: {
    'dist-tags': { latest: '9.9.9' },
    versions: {
      '1.2.3': {
        version: '1.2.3', license: 'Apache-2.0', scripts: {},
        dist: { attestations: { provenance: { predicateType: 'fixture' } } },
        ...overrides,
      },
      '9.9.9': { version: '9.9.9', license: 'Apache-2.0', scripts: {} },
    },
  },
});

function run(installs, routes = {}, names = installs.map((_, i) => `entry-${i}.json`)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dkg-security-'));
  try {
    const callsPath = path.join(dir, 'calls.json');
    const mockPath = path.join(dir, 'mock.mjs');
    writeFileSync(callsPath, '');
    writeFileSync(mockPath, `
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      const routes = JSON.parse(process.env.MOCK_ROUTES);
      globalThis.fetch = async (url, options) => {
        appendFileSync(process.env.MOCK_CALLS, JSON.stringify(url) + '\\n');
        assert.deepEqual(options, { headers: { Accept: 'application/json' } });
        assert.ok(Object.hasOwn(routes, url), 'unexpected request: ' + url);
        const { status, body } = routes[url];
        return { status, ok: status >= 200 && status < 300, json: async () => body };
      };
    `);
    installs.forEach((install, i) => writeFileSync(path.join(dir, names[i]), JSON.stringify({ license: 'Apache-2.0', install })));
    const result = spawnSync(process.execPath, ['--import', mockPath, checker, ...names], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512', UV_THREADPOOL_SIZE: '1', OMP_NUM_THREADS: '1', MOCK_ROUTES: JSON.stringify(routes), MOCK_CALLS: callsPath },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    return { status: result.status, output: result.stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [pkg, flags] of [['example-dkg', []], ['example-dkg', ['-y']], ['@example/dkg', ['--yes']]]) {
  test(`npx ${flags.join(' ')} ${pkg}@1.2.3 checks the exact pinned package`, () => {
    const result = run([npx(`${pkg}@1.2.3`, flags)], { [npmUrl(pkg)]: published() });
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, [npmUrl(pkg)]);
    assert.match(result.output, new RegExp(`provenance attestation present on ${pkg}@1\\.2\\.3`));
    assert.match(result.output, /0 error\(s\) · 0 warning\(s\)/);
    assert.doesNotMatch(result.output, /9\.9\.9/);
  });
}

test('npx package arguments do not change the selected package', () => {
  const install = npx('example-dkg@1.2.3');
  install.args.push('--port', '3000');
  const result = run([install], { [npmUrl('example-dkg')]: published() });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [npmUrl('example-dkg')]);
});

test('unpinned ordinary npx retains latest metadata lookup', () => {
  const result = run([npx('example-dkg')], { [npmUrl('example-dkg')]: published() });
  assert.equal(result.status, 0);
  assert.match(result.output, /example-dkg@9\.9\.9 has no npm provenance/);
});

for (const install of [
  { kind: 'cli', package: 'example-dkg', version: '1.2.3', binary: 'example-dkg' },
  { kind: 'agent-plugin', framework: 'hermes', package: '@example/dkg', version: '1.2.3' },
  { kind: 'service', runtime: 'npm-global', npmGlobal: { package: '@example/dkg', version: '1.2.3' } },
]) {
  test(`${install.kind} ${install.runtime ?? ''} retains explicit npm package/version lookup`, () => {
    const pkg = install.package ?? install.npmGlobal.package;
    const result = run([install], { [npmUrl(pkg)]: published() });
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, [npmUrl(pkg)]);
    assert.match(result.output, /@1\.2\.3/);
    assert.match(result.output, /0 error\(s\) · 0 warning\(s\)/);
  });
}

test('missing pinned version remains a hard failure without falling back to latest', () => {
  const result = run([npx('@example/dkg@2.0.0')], { [npmUrl('@example/dkg')]: published() });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [npmUrl('@example/dkg')]);
  assert.match(result.output, /pinned version "2\.0\.0" is not published/);
  assert.match(result.output, /1 error\(s\) · 0 warning\(s\)/);
  assert.doesNotMatch(result.output, /provenance attestation present/);
});

for (const hook of ['preinstall', 'install', 'postinstall']) {
  test(`${hook} remains a hard failure`, () => {
    const result = run([npx('example-dkg@1.2.3')], { [npmUrl('example-dkg')]: published({ scripts: { [hook]: 'node setup.js' } }) });
    assert.equal(result.status, 1);
    assert.match(result.output, new RegExp(`declares a "${hook}" script`));
    assert.match(result.output, /1 error\(s\)/);
  });
}

test('license mismatch and missing npm provenance remain warnings', () => {
  const result = run([npx('example-dkg@1.2.3')], { [npmUrl('example-dkg')]: published({ license: 'MIT', dist: {} }) });
  assert.equal(result.status, 0);
  assert.match(result.output, /reports "MIT"/);
  assert.match(result.output, /no npm provenance attestation/);
  assert.match(result.output, /0 error\(s\) · 2 warning\(s\)/);
});

test('actual PR33 uvx --from install is unsupported and never queries npm', () => {
  // Exact install block from OriginTrail/dkg-integrations PR33 at
  // 9867cb73603a969cdb5cef294c08088c61523779/integrations/patent-evidence.json.
  // Full entry SHA256: 1d5b2316d8dba9527f9c41ef3ca986ab071b543fc1959190d5b7a1860738acb1.
  const result = run([{
    kind: 'mcp', command: 'uvx',
    args: ['--from', 'patent-evidence-dkg==0.2.0', 'patent-evidence', 'mcp'],
    envRequired: ['DKG_API_URL', 'DKG_AUTH_TOKEN', 'PATENT_EVIDENCE_STATE', 'PATENT_EVIDENCE_PROJECT'],
    supportedClients: ['cursor', 'claude-code', 'claude-desktop'],
  }]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /Unsupported MCP launcher "uvx"; npm lookup skipped/);
  assert.match(result.output, /Package existence, install hooks, license and provenance are not verified.*manual review required/);
  assert.match(result.output, /0 error\(s\) · 1 warning\(s\)/);
  assert.doesNotMatch(result.output, /not yet published|provenance attestation present/);
});

for (const command of ['python', 'unknown-runner', 'npm', '/usr/bin/npx']) {
  test(`unsupported launcher ${command} never queries npm`, () => {
    const result = run([{ kind: 'mcp', command, args: ['example-dkg@1.2.3'] }]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /Unsupported MCP launcher/);
    assert.match(result.output, /not verified.*manual review required/);
  });
}

for (const args of [
  [], ['-y'], ['--package', '@example/dkg@1.2.3', 'dkg'],
  ['-p', '@example/dkg@1.2.3', 'dkg'], ['--package=@example/dkg@1.2.3', 'dkg'],
  ['--call', 'example-dkg'], ['--unknown', 'example-dkg@1.2.3'],
  ['--', 'example-dkg@1.2.3'], ['https://example.com/dkg.tgz'], ['./local-package'],
  ['github:example/dkg'], ['alias@npm:example-dkg@1.2.3'], ['example-dkg.tgz'],
]) {
  test(`ambiguous npx args ${JSON.stringify(args)} require manual review without npm`, () => {
    const result = run([{ kind: 'mcp', command: 'npx', args }]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /Unsupported npx argument shape/);
    assert.match(result.output, /not verified.*manual review required/);
    assert.match(result.output, /0 error\(s\) · 1 warning\(s\)/);
  });
}

test('manual entry reports coverage without changing its successful exit or warning count', () => {
  const result = run([{ kind: 'manual', docsUrl: 'https://example.com/docs' }]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /No npm package checks apply to install kind "manual"/);
  assert.match(result.output, /not verified.*manual review required/);
  assert.match(result.output, /0 error\(s\) · 0 warning\(s\)/);
});

for (const digest of [undefined, `sha256:${'a'.repeat(64)}`]) {
  test(`docker ${digest ? 'with' : 'without'} digest preserves declaration-only checks`, () => {
    const result = run([{ kind: 'service', runtime: 'docker', docker: { image: 'example/dkg', version: '1.2.3', digest } }]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /not verified.*manual review required/);
    assert.match(result.output, digest ? /Runtime resolution against the registry is not performed/ : /docker install declared without an image digest/);
    assert.match(result.output, digest ? /0 warning\(s\)/ : /1 warning\(s\)/);
  });
}

test('ordinary npm success follows a missing-package warning in the same invocation', () => {
  const result = run([npx('not-published@1.2.3'), npx('@example/dkg@1.2.3')], {
    [npmUrl('not-published')]: { status: 404 }, [npmUrl('@example/dkg')]: published(),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [npmUrl('not-published'), npmUrl('@example/dkg')]);
  assert.match(result.output, /not-published.*not yet published/);
  assert.match(result.output, /provenance attestation present on @example\/dkg@1\.2\.3/);
  assert.match(result.output, /2 entries checked · 0 error\(s\) · 1 warning\(s\)/);
});

test('ordinary npm success follows a missing-version hard failure without clearing the error', () => {
  const result = run([npx('example-dkg@2.0.0'), npx('@example/dkg@1.2.3')], {
    [npmUrl('example-dkg')]: published(), [npmUrl('@example/dkg')]: published(),
  });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [npmUrl('example-dkg'), npmUrl('@example/dkg')]);
  assert.match(result.output, /pinned version "2\.0\.0" is not published/);
  assert.match(result.output, /provenance attestation present on @example\/dkg@1\.2\.3/);
  assert.match(result.output, /2 entries checked · 1 error\(s\) · 0 warning\(s\)/);
});

test('scaffold template remains skipped without any package lookup', () => {
  const result = run([npx('placeholder@1.2.3')], {}, ['TEMPLATE.json']);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /skipping: scaffold template/);
});

test('no entries retains usage exit 2', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: security-checks/);
});
