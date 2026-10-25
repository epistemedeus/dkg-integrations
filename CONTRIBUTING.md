# Contributing to the DKG Integrations Registry

This document walks you through submitting an integration to the registry. Read the bounty call (Sections 5–8a) first if you're participating in a funded round — the bounty document is the binding scope.

---

## TL;DR

1. Ship your integration in your own repository.
2. Publish a release to npm (or docker, for `kind: service` integrations).
3. Fork this registry, copy `integrations/TEMPLATE.json` to `integrations/<your-slug>.json`, fill it out.
4. Open a PR here.
5. CI runs; the committee reviews; your integration lands in the registry.

---

## 1. Choose your slug

Your slug is the canonical identifier for your integration. It must:

- match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`
- be 3–60 characters
- be unique across the registry
- follow the DKG look-before-mint normalization rule:
  lowercase → ASCII-fold → strip stopwords (the/a/an/of/for/and/or/to/in/on/with) → hyphenate

Before minting a slug, search the registry (`rg '"slug":' integrations/`) to see if something analogous already exists; reuse converges the graph, divergence fragments it.

## 2. Pick an install kind

One of:

- **`mcp`** — your integration is an MCP server. The installer wires it into Cursor / Claude Code / Claude Desktop / the DKG node via their respective MCP configs.
- **`service`** — your integration is a long-running process (docker, npm-global daemon, or a downloadable binary).
- **`cli`** — your integration is a one-shot CLI tool. The installer installs it globally; the operator invokes it on demand.
- **`agent-plugin`** — your integration plugs into a specific agent framework (OpenClaw, ElizaOS, Hermes, AutoResearch).
- **`manual`** — your integration's install is complex enough that automation doesn't help; the installer links out to your docs.

Pick the one that most closely matches reality. If none fits, open an issue before submitting.

## 3. Declare your security posture

The `security` block in your entry is not marketing copy. It is a **contract** between your integration and the operators installing it. Lying here is grounds for removal and, for bounty submissions, disqualification.

- `security.networkEgress` — every external host your integration contacts. The local DKG node on `127.0.0.1` does not count.
- `security.writeAuthority` — every DKG endpoint (or CLI command) your integration invokes that mutates state. List by path (`POST /api/assertion/create`, etc.). If you call any Curator-authority operation (PUBLISH, SHARE, endorse, verify), they **must** appear here.
- `security.credentialsHandled` — third-party credentials the installer will prompt the user for. Do not list the DKG auth token here; the installer handles it.
- `security.notes` — freeform prose covering anything the structured fields don't capture. If your package has any `postinstall` behavior, explain it here; default posture is "no install scripts."

### Choosing `publicInterfacesUsed`

This is the field reviewers audit for scope compliance, and it is the one most often
mis-declared. It describes **how your code reaches the node** — not what you expose
to your own users.

- **`http-api`** — your code calls `/api/...` on the node. This is the right answer
  for almost everything.
- **`cli`** — your code shells out to the `dkg` binary. Choose this only if you
  genuinely invoke it (e.g. to reuse a setup flow that isn't a single HTTP call);
  it means `dkg` must be on the operator's `PATH`.
- **`mcp`** — your code is itself an **MCP client** of the DKG's MCP server.
  Worth it only to reuse a composite tool the HTTP API doesn't expose in one call
  (`dkg_knowledge_asset_import_file`, for example). Never chain through the DKG MCP
  server just to reach `/api/...` — call it directly. Declaring `mcp` couples you to
  `@origintrail-official/dkg-mcp`, whose tool schema tracks node releases, and adds
  a process hop.

**If your integration IS an MCP server that calls `/api/...`, declare `http-api`
alone.** That you are an MCP server is already recorded by `install.kind: mcp`;
`publicInterfacesUsed` answers a different question. Declaring `mcp` here sends
reviewers looking for an MCP client that doesn't exist.

If you build an MCP server, it is also worth saying in `fitNotes` whether it is
self-contained or expects the DKG's own MCP server installed alongside it — users
deciding what to install have no other way to tell, and installing both means the
agent sees two overlapping ways to do the same thing.

## 4. Pin your version

Your entry carries:

- `commit` — full 40-character git SHA of the state your submission represents.
- For `kind: cli` and `kind: service` (npm-global), a published npm `package` at a specific `version`.
- For `kind: service` (docker), an `image` and `version`, and ideally a `digest` (sha256).
- For `kind: mcp`, typically an npx invocation that pins the package version in the args.

Pin to a specific version. "latest" is not a pin. Updates require a new registry PR (this is intentionally cheap — small diff, fast review).

## 5. Open the PR

Use `integrations/TEMPLATE.json` as a starting point. Submit the PR with:

- Title: `Add <your-integration-name>` (or `Update <slug> to v<version>`).
- The PR checklist filled in (it's applied automatically from `.github/PULL_REQUEST_TEMPLATE.md`).
- A link to your design brief (bounty submissions — see bounty doc Section 8).
- A link to your demo (bounty submissions — recorded walkthrough or live endpoint).

## 6. What happens next

<!-- Updated October 2026: runner-aware package-check coverage. -->
- **CI runs.** Schema + structural checks via `scripts/validate.mjs`; security checks via `scripts/security-checks.mjs` against supported npm install declarations. Other MCP launchers (including `uvx`) and ambiguous npx arguments warn that package checks require manual review, without querying npm. See [package-check coverage](README.md#what-ci-checks-automatically) for the supported shapes and limits.
- **Committee review.** Fit, quality, and trust tier are assigned by humans, not CI.
- **Merge and tier.** The committee may merge your entry as `community`, `verified`, or `featured`. You submit as `community`; upgrades are decided by the committee.

## 7. Keeping your entry fresh

To ship a new version of your integration:

- Release it in your own repo (new git SHA, new package version).
- Open a small registry PR bumping `commit` and the relevant `install.*.version` (or `args`).
- Re-declare any changed security posture if your integration touches new endpoints, domains, or credentials.

---

## Local dev

```bash
git clone https://github.com/OriginTrail/dkg-integrations.git
cd dkg-integrations
npm install
npm run validate         # runs the schema + structural checks on every entry
npm run security-checks  # checks the dkg-hello-world entry against npm
node --test --test-concurrency=1 scripts/security-checks.test.mjs  # offline checker regressions
```

---

## Questions

- Bounty scope: see the v10 bounty document on the OriginTrail official channel.
- Registry mechanics: open an issue in this repo.
- General DKG v10 questions: [Discord](https://discord.com/invite/xCaY7hvNwD) or the main [`OriginTrail/dkg`](https://github.com/OriginTrail/dkg) repository.
