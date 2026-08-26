# Releasing

Releases are driven by [Changesets](https://changesets.dev) and published to npm
with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) — OIDC, no
long-lived npm token.

## The everyday loop

1. Every PR that changes something publishable includes a changeset:

   ```sh
   bun run change
   ```

   That writes a markdown file into `.changeset/`. Commit it with the PR.

2. Merging to `main` runs `.github/workflows/release.yml`. `select-mode` sees
   pending changesets and opens (or refreshes) a **Version Packages** PR that
   bumps versions and writes CHANGELOGs.

3. Merging the Version Packages PR leaves no changesets behind. The next run of
   the workflow flips to publish mode: it builds all six targets, then publishes.

`@build-qube/papyra` and `@build-qube/papyra-native` are in `fixed` in
`.changeset/config.json`, so they always release together on the same version.
`papyra-demo` and `papyra-bench` are in `ignore` and never publish.

## What actually gets published

Eight packages, not two. napi-rs splits the binary out into one package per
platform, and the loader in `index.js` picks the right one at runtime.

| Package | Published by |
| --- | --- |
| `@build-qube/papyra` | `changeset publish` |
| `@build-qube/papyra-native` | `changeset publish` |
| `@build-qube/papyra-native-darwin-arm64` | `napi prepublish` |
| `@build-qube/papyra-native-darwin-x64` | `napi prepublish` |
| `@build-qube/papyra-native-linux-arm64-gnu` | `napi prepublish` |
| `@build-qube/papyra-native-linux-x64-gnu` | `napi prepublish` |
| `@build-qube/papyra-native-win32-x64-msvc` | `napi prepublish` |
| `@build-qube/papyra-native-wasm32-wasi` | `napi prepublish` |

The six platform packages are generated at release time from the `napi.targets`
list in `packages/bindings/package.json`, filled with the CI build artifacts, and
published by the `publish-platforms` step of the root `release` script, which runs
before `changeset publish`. **Adding a target to `napi.targets` adds a ninth
package**, which will need its own trusted publisher before it can go out.

That step deliberately does *not* live in a `prepublishOnly` hook. `changeset
publish` shells out to `npm publish --json`, and npm collapses a lifecycle
script's entire stderr into a single `"command failed"` string — a registry
rejection inside the hook is undiagnosable from the workflow log. Running it as
its own step keeps the real error visible.

## One-time npm setup

### The chicken-and-egg problem

npm will only let you configure a trusted publisher on a package that already
exists. None of these eight exist yet, so the first release cannot use OIDC.
(This is an [acknowledged npm limitation](https://github.com/npm/cli/issues/8544);
PyPI allows pre-registering, npm does not.)

So: **first release on a token, every release after that on OIDC.**

### Step 1 — make sure the scope exists

The `@build-qube` scope must exist on npmjs.com and your account must be able to
publish to it. Check with `npm org ls build-qube`.

### Step 2 — bootstrap release, on a token *(done)*

The first release of each package went out on a granular access token, because
trusted publishing cannot be configured for a package that does not exist. That
is finished: all eight packages exist, so nothing here needs doing again unless a
**new** package is added — a new `napi.targets` entry, for instance.

If you ever do need it, the token settings that matter are:

| Section | Value |
| --- | --- |
| **Packages and scopes** | **Read and write**, on the **`@build-qube` scope** |
| Organizations | No access (not needed to publish) |
| Bypass two-factor authentication (2FA) | Checked — CI cannot answer an OTP |

Two traps live in that first row, and the token page states them plainly enough
to miss:

- **"Packages and scopes" and "Organizations" are separate axes.** Granting the
  token read/write on the `build-qube` *organization* gives it org
  administration — members, teams, settings — and **no ability to publish**. If
  the page says *"This token has no access to packages and scopes"*, it cannot
  publish, however much org access it has. This is what broke the first release.
- **Pick the scope, not individual packages.** Publishing a package that does not
  exist yet is a create, and a token restricted to "only select packages" cannot
  create — there is nothing to select when you make it.

Add it as `NPM_TOKEN` (`gh secret set NPM_TOKEN --repo BuildQube/Papyra`) and pass
it as `NODE_AUTH_TOKEN` on the `Publish` step for the one release, then take it
straight back out — a token present in that step **takes precedence over OIDC**,
so leaving it there silently disables trusted publishing.

### Step 3 — configure trusted publishers *(done)*

For each of the eight packages, on npmjs.com:

**Package → Settings → Trusted Publisher → GitHub Actions**, then:

| Field | Value |
| --- | --- |
| Organization or user | `BuildQube` |
| Repository | `Papyra` |
| Workflow filename | `release.yml` |
| Environment | *(leave blank)* |

The workflow filename must be exactly `release.yml`. This is why publishing lives
in its own workflow and why the build matrix is duplicated there rather than
pulled in with `workflow_call` — npm validates the OIDC claim against the workflow
that contains the publish step, and a reusable workflow reports the *caller's*
filename instead, which fails the check.

All eight, not just the two obvious ones: napi publishes the six platform
packages with its own `npm publish` calls, and npm checks the claim per package.

### Step 4 — turn the token off

1. Delete the `NODE_AUTH_TOKEN` block from the `Publish` step in `release.yml`.
   **Done** — the workflow now publishes over OIDC. A token in that step takes
   precedence, so re-adding one silently disables trusted publishing.
2. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com.
3. On each package: **Settings → Publishing access → Require two-factor
   authentication and disallow tokens**. This is the step that actually buys you
   something: after it, a stolen npm token cannot publish papyra at all.

Do 2 and 3 only once an OIDC release has actually succeeded — until then the
token is the way back.

From here on, releases need no npm credentials anywhere in the repo, and npm
attaches [provenance](https://docs.npmjs.com/generating-provenance-statements)
attestations automatically — no `--provenance` flag, no `NPM_CONFIG_PROVENANCE`.

## Requirements the workflow already handles

- **`id-token: write`** — only on the `publish` job. Nothing else in this repo
  requests it.
- **npm >= 11.5.1** — OIDC support landed there. The publish job runs
  `npm install -g npm@latest` rather than trusting the runner image.
- **`registry-url` on `setup-node`** — needed even without a token; without it npm
  does not attempt the OIDC exchange.
- **npm, not bun** — `changeset publish` shells out to `npm publish` (changesets
  falls back to npm for any package manager it does not special-case), and so does
  `napi prepublish`. `bun publish` has no OIDC support, so this matters.

One repo setting is *not* in the workflow: **Settings → Actions → General →
Allow GitHub Actions to create and approve pull requests** must be enabled, or the
Version Packages PR cannot be opened.

## Troubleshooting

**`E404 Not Found - PUT https://registry.npmjs.org/@build-qube%2f...`** during an
OIDC publish usually means that specific package has no trusted publisher
configured — the scoped-package case is a
[known sharp edge](https://github.com/npm/cli/issues/8976). Check all eight, not
just the two obvious ones.

**`npm whoami` succeeds but publishing is rejected.** Authentication and
authorisation are different questions: a granular token with org access but no
**Packages and scopes** permission authenticates fine and cannot publish a thing.
Check that section of the token page, not just that the token works.

**The publish job fails with nothing but `command failed`.** That is npm folding a
lifecycle script's stderr into one string. If you see it, something has been moved
back into a `prepublishOnly`/`prepack` hook — run it as its own step in the
`release` script instead, where the real error prints. The `Check registry
credentials` step exists to catch the common case (a bad or under-scoped token)
before anything reaches that path.

**A published package fails to install with `EUNSUPPORTEDPROTOCOL`.** Something
in a publishable manifest uses a `workspace:` range. Changesets publishes through
`npm publish`, and unlike pnpm/yarn/bun, npm does not rewrite that protocol while
packing — it goes to the registry verbatim and no consumer can install it.
`bun run check:publishable` guards against this in CI and again in the `release`
script; depend on the real version instead and let Changesets keep it in step.

**A platform package is missing from a release.** `napi prepublish` only publishes
what it finds under `packages/bindings/npm/<platform>/`, which is filled from the
CI artifacts. If a build matrix leg failed, its package is silently skipped —
check the `build` jobs before assuming the publish worked.

**The Version Packages PR does not appear.** Either the "allow Actions to create
pull requests" setting above is off, or there were no changesets to version.
