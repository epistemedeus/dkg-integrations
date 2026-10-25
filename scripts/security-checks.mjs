#!/usr/bin/env node
// Security checks run per-entry as part of registry CI.
//
// These are the Section 8a checks that can be automated:
//
//   - no postinstall/preinstall/install scripts in the published npm package
//     (for cli, service-npm-global, agent-plugin, and supported mcp-npx launches)
//   - declared license matches the published package's license field
//   - npm package exists at the declared version
//   - docker image digest declaration (runtime resolution is not performed)
//
// This script is deliberately read-only: it does not `npm install` anything;
// it uses the npm registry HTTP API so CI runs are fast and sandboxed.
//
// Usage:
//   node scripts/security-checks.mjs <path.json>...
//
// Exits non-zero only on hard-fail findings; warnings do not fail CI.

import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: security-checks.mjs <integrations/*.json>...');
  process.exit(2);
}

const findings = [];
let hardFails = 0;

for (const file of argv) {
  const rel = path.relative(process.cwd(), file);

  // TEMPLATE.json is a scaffold contributors copy; it deliberately points at
  // placeholder packages that will never resolve. Skip it.
  if (path.basename(file) === 'TEMPLATE.json') {
    findings.push({ level: 'info', file: rel, msg: 'skipping: scaffold template, not a real entry.' });
    continue;
  }

  const entry = JSON.parse(await fs.readFile(file, 'utf8'));

  // ── Determine the npm package from the install kind and runner ────────
  const { pkg, pkgVersion, unsupported } = resolveNpmPackage(entry.install);

  if (!pkg) {
    findings.push({
      level: unsupported ? 'warn' : 'info',
      file: rel,
      msg: `${unsupported ?? `No npm package checks apply to install kind "${entry.install.kind}"${entry.install.runtime ? ` (runtime "${entry.install.runtime}")` : ''}.`} Package existence, install hooks, license and provenance are not verified by this checker; manual review required.`,
    });
  }

  if (pkg) {
    const lookup = await fetchNpmMeta(pkg, pkgVersion);

    // "package exists but the pinned version is missing" is a hard fail —
    // it means the entry points at a version nobody published (pin rot or
    // a replay-attack surface). "package doesn't exist on npm at all" is a
    // warning — first-party scaffolds in this repo can legitimately sit
    // un-published for a short while, and contributors may PR an entry
    // ahead of their first npm publish. Human reviewers catch that case.
    if (lookup.status === 'missing-version') {
      findings.push({
        level: 'error',
        file: rel,
        msg: `npm package "${pkg}" exists on registry.npmjs.org but pinned version "${pkgVersion}" is not published. Either publish ${pkgVersion} or update the entry to a version that exists.`,
      });
      hardFails += 1;
      continue;
    }
    if (lookup.status === 'missing-package') {
      findings.push({
        level: 'warn',
        file: rel,
        msg: `npm package "${pkg}" is not yet published on registry.npmjs.org. Security checks (install hooks, license, provenance) will run once it is published. Reviewers: confirm the package is expected to land before this entry is merged into any user-facing trust tier.`,
      });
      continue;
    }
    const meta = lookup.meta;

    // scripts check
    const scripts = meta.scripts ?? {};
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      if (hook in scripts) {
        findings.push({
          level: 'error',
          file: rel,
          msg: `published package ${pkg}@${meta.version} declares a "${hook}" script: ${JSON.stringify(scripts[hook])}. Install hooks are disallowed (Section 8a).`,
        });
        hardFails += 1;
      }
    }

    // license consistency
    const declaredLicense = entry.license;
    const pkgLicense = typeof meta.license === 'string' ? meta.license : meta.license?.type;
    if (pkgLicense && pkgLicense !== declaredLicense) {
      findings.push({
        level: 'warn',
        file: rel,
        msg: `registry declares license "${declaredLicense}" but published package ${pkg}@${meta.version} reports "${pkgLicense}".`,
      });
    }

    // provenance attestation — informational for now
    if (!meta._hasProvenance) {
      findings.push({
        level: 'warn',
        file: rel,
        msg: `published package ${pkg}@${meta.version} has no npm provenance attestation. Verified/featured tier requires provenance; community tier does not.`,
      });
    } else {
      findings.push({
        level: 'info',
        file: rel,
        msg: `provenance attestation present on ${pkg}@${meta.version}.`,
      });
    }
  }

  // ── Docker image digest (if declared) ──────────────────────────────────
  const docker = entry.install.docker;
  if (docker?.digest) {
    findings.push({
      level: 'info',
      file: rel,
      msg: `docker digest declared: ${docker.image}@${docker.digest}. (Runtime resolution against the registry is not performed in CI.)`,
    });
  } else if (entry.install.kind === 'service' && entry.install.runtime === 'docker') {
    findings.push({
      level: 'warn',
      file: rel,
      msg: `docker install declared without an image digest. Verified/featured tier requires a pinned sha256 digest.`,
    });
  }
}

for (const f of findings) {
  const prefix = f.level === 'error' ? '✖' : f.level === 'warn' ? '!' : 'i';
  process.stdout.write(`${prefix} ${f.file}: ${f.msg}\n`);
}

process.stdout.write(
  `\n${argv.length} entr${argv.length === 1 ? 'y' : 'ies'} checked · ${findings.filter((f) => f.level === 'error').length} error(s) · ${findings.filter((f) => f.level === 'warn').length} warning(s)\n`,
);

if (hardFails > 0) process.exit(1);

// ── helpers ────────────────────────────────────────────────────────────────

function resolveNpmPackage(install) {
  switch (install.kind) {
    case 'cli':
      return { pkg: install.package, pkgVersion: install.version };
    case 'service':
      if (install.runtime === 'npm-global' && install.npmGlobal) {
        return { pkg: install.npmGlobal.package, pkgVersion: install.npmGlobal.version };
      }
      return { pkg: null };
    case 'agent-plugin':
      return { pkg: install.package, pkgVersion: install.version };
    case 'mcp': {
      if (install.command !== 'npx') {
        return { unsupported: `Unsupported MCP launcher ${JSON.stringify(install.command)}; npm lookup skipped.` };
      }
      // Only consume known, value-free npx flags before a registry package.
      // Other options can select a different package or command (e.g. --package,
      // --call); never guess by taking their first non-option argument.
      const args = install.args ?? [];
      let i = 0;
      while (args[i] === '-y' || args[i] === '--yes') i += 1;
      const pkgArg = args[i];
      // Exclude paths, URLs, aliases and other non-registry package specs.
      const m = pkgArg?.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^@\s/:]+))?$/);
      if (!m || m[1].endsWith('.tgz')) {
        return { unsupported: 'Unsupported npx argument shape; npm lookup skipped. Supported shape: npx [-y|--yes] <package>[@version] [package arguments...].' };
      }
      return { pkg: m[1], pkgVersion: m[2] };
    }
    default:
      return { pkg: null };
  }
}

async function fetchNpmMeta(pkg, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return { status: 'missing-package' };
  if (!res.ok) return { status: 'missing-package' };
  const body = await res.json();
  // Hard requirement: if a version is pinned in the entry, it MUST exist on
  // the registry. We do not silently fall back to "latest" — that would let
  // entries pass CI while pointing at a version nobody has published.
  if (version) {
    const target = body.versions?.[version];
    if (!target) return { status: 'missing-version' };
    return { status: 'ok', meta: meta(target) };
  }
  const latest = body['dist-tags']?.latest;
  const target = latest ? body.versions?.[latest] : null;
  if (!target) return { status: 'missing-version' };
  return { status: 'ok', meta: meta(target) };
}

function meta(versionDoc) {
  return {
    version: versionDoc.version,
    scripts: versionDoc.scripts,
    license: versionDoc.license,
    _hasProvenance:
      Boolean(versionDoc.dist?.attestations?.provenance?.predicateType) ||
      Boolean(versionDoc.dist?.signatures?.length),
  };
}
