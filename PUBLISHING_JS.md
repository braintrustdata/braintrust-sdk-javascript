# Publishing JavaScript SDK Packages

This is the human guide to the JavaScript release process.

**Important:** all publishing happens in **GitHub Actions**. Do **not** publish from your laptop.

---

## Start here

| I want to...                                            | What to do                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Make my PR release something                            | Run `pnpm changeset` and commit the generated `.changeset/*.md` file                      |
| Ship a normal stable release to npm `latest`            | Merge the auto-created release PR on `main`, then approve the `npm-publish` environment   |
| Publish a branch build for testing                      | Run the **Release Packages** workflow with `release_mode=prerelease` and your branch name |
| Get the latest nightly snapshot from `main`             | Install `@canary`                                                                         |
| Manually trigger a canary publish                       | Run the **Release Packages** workflow with `release_mode=canary`                          |
| Preview what would publish without actually publishing  | Run the workflow with a `dry-run-*` mode                                                  |
| Figure out why release automation did nothing or failed | Read [Troubleshooting](#troubleshooting)                                                  |

---

## What this covers

Public JS SDK packages:

- `braintrust`
- `@braintrust/browser`
- `@braintrust/langchain-js`
- `@braintrust/openai-agents`
- `@braintrust/otel`
- `@braintrust/templates-nunjucks-js`
- `@braintrust/temporal`
- `@braintrust/vercel-ai-sdk`

---

## Before anything else: add a changeset

If your PR changes a publishable package, it usually needs a changeset.

```bash
pnpm changeset
```

That command will ask:

1. which package(s) changed
2. whether the bump is `patch`, `minor`, or `major`
3. what should appear in the changelog

Commit the generated `.changeset/*.md` file with your PR.

### How to choose the bump type

| Bump    | Use it for                                                                                         | Examples                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `patch` | Bug fixes, internal refactors, performance work, dependency updates, docs-only API-neutral changes | Fix a crash, improve retry logic, bump a dependency                                           |
| `minor` | New backwards-compatible functionality                                                             | Add a new method, export a new helper, add an optional parameter                              |
| `major` | Breaking changes                                                                                   | Remove or rename public API, change behavior in a way that may break users, drop Node support |

**Rule of thumb:** if you are unsure, pick `patch`. Review can always adjust it later.

### Example changeset

```markdown
---
"braintrust": patch
---

Fix span export when using custom headers
```

You can edit the generated file by hand before committing it.

### When you do not need a changeset

You usually do **not** need one for docs-only, test-only, or CI-only changes.

If your PR touches a publishable package but should **not** trigger a release, bypass the check by using one of these:

- add the `skip-changeset` label to the PR
- include `#skip-changeset` in the PR title or body

---

## Stable release (`latest`)

This is the normal production release flow.

### The important mental model

A stable release is a **two-step process**:

```text
feature PR with changeset
→ merge to main
→ automation opens or updates a release PR
→ merge the release PR
→ approve npm-publish
→ packages publish to npm
```

**Merging your feature PR does not publish anything by itself.**
It only feeds changes into the next release PR.

### What to do

1. Merge your PR with its changeset into `main`.
2. Wait for GitHub Actions to create or update the release PR.
3. Review the release PR:
   - are the package bumps correct?
   - do the changelog entries read well?
4. Merge the release PR.
5. Open the workflow run and approve the `npm-publish` environment when prompted.
6. The workflow publishes to npm, pushes release tags, and creates GitHub Releases.

### What stable release creates

- npm publishes on the `latest` dist-tag
- Changesets package tags such as `braintrust@3.8.0`
- GitHub Releases

### What stable release does not require

- no manual version bumping
- no local publishing
- no manual git tagging

### If no release PR appears

Usually one of these is true:

- there are no unreleased changesets on `main`
- the workflow has not run yet
- the existing release PR already contains the pending changes

See [Troubleshooting](#troubleshooting) for the exact checks to make.

---

## Canary release (`canary`)

Canaries are nightly snapshots from `main`.

Use them when someone wants the newest merged JS SDK code without waiting for the next stable release.

### How it works

```text
nightly scheduler workflow dispatches canary publish on main
→ check for pending changesets
→ check whether HEAD already has a canary
→ check whether latest CI passed
→ publish @canary if needed
```

### Behavior

- runs automatically every night at **04:00 UTC**
- can also be triggered manually with `release_mode=canary`
- skips if there are no pending changesets
- skips if the current `main` commit already has a canary
- skips if the latest required CI run on `main` did not succeed

### Install a canary

```bash
npm install braintrust@canary
npm install @braintrust/otel@canary
```

### Canary version format

```text
1.2.3-canary.20260404040000.abc1234
```

That includes:

- the base version
- a timestamp
- the short commit hash

### What canaries do not do

- do not create git tags
- do not create GitHub Releases
- do not commit version changes back to the repo
- do not need manual environment approval

---

## Prerelease from a branch (`rc`)

Use a prerelease when you want to publish a test build from a branch before merging to `main`.

### What to do

1. Open **Actions** in GitHub.
2. Open the **Release Packages** workflow.
3. Click **Run workflow**.
4. Set:
   - `release_mode=prerelease`
   - `branch=<your branch>`
5. Run the workflow.
6. After it finishes, install from the `rc` dist-tag:

```bash
npm install braintrust@rc
```

### What prereleases do not do

- do not create git tags
- do not create GitHub Releases
- do not commit version changes back to the repo
- do not publish packages that have no releasable changesets on that branch

---

## Dry run

Use a dry run when you want to answer: **what would publish if I ran this for real?**

Available modes:

| Mode                 | Simulates                 |
| -------------------- | ------------------------- |
| `dry-run-stable`     | stable release from a ref |
| `dry-run-prerelease` | prerelease from a branch  |
| `dry-run-canary`     | canary publish from a ref |

Dry runs will:

- compute versions
- build the publishable packages
- create tarball artifacts
- show a summary in the workflow output

Dry runs will **not**:

- publish to npm
- create tags
- create GitHub Releases
- commit anything back to the repo

---

## Troubleshooting

If the release process is confusing or appears to have done nothing, start here.

### First: find the exact step that failed or skipped

Open the **Release Packages** workflow run in GitHub Actions and look for the first step that is red, or the first summary that says something was skipped.

The step name usually tells you what class of problem you are dealing with.

---

### Symptom: my PR failed `changeset-required`

Cause: your PR changed a publishable package and did not include a changeset.

Fix:

```bash
pnpm changeset
```

Commit the generated file and push again.

If the PR should not trigger a release, use `skip-changeset` or `#skip-changeset`.

---

### Symptom: I merged my PR to `main`, but nothing published

This is usually **expected**.

Merging a normal PR to `main` does **not** publish a stable release. It creates or updates the release PR.

What to check:

1. Did the workflow create or update the release PR?
2. Did anyone merge the release PR?
3. After merging the release PR, did someone approve the `npm-publish` environment?

If the answer to any of those is no, nothing will publish yet.

---

### Symptom: no release PR showed up after merging to `main`

Check these in order:

1. **Were there any pending changesets on `main`?**
   - No pending changesets means no release PR update is needed.
2. **Did the `stable-release-pr` job run successfully?**
   - If not, open the failing step in GitHub Actions.
3. **Was there already an open release PR?**
   - The workflow updates the existing release PR instead of opening a new one.

---

### Symptom: I merged the release PR, but stable publish was skipped

The stable publish job only runs when GitHub detects that `main` is on a merged Changesets release commit.

In practice, this means the head commit on `main` needs to be the release PR commit (the one with commit message like `[ci] release`).

If the workflow summary says something like:

- _"Unpublished package versions exist, but HEAD is not a merged Changesets release commit, so stable publish is skipped."_

then the release commit detection did not match what the workflow expected.

What to check:

1. Was the release PR actually merged?
2. Did another commit land on `main` first?
3. Is the workflow run attached to the release PR merge commit?

---

### Symptom: the workflow is waiting and nothing is happening

For stable releases, this usually means the run is waiting on the **`npm-publish` environment approval**.

Fix: open the workflow run in GitHub Actions and click **Approve** for that environment.

Canary and prerelease publishes do **not** require that approval gate.

---

### Symptom: canary did not publish

Common reasons:

1. **No pending changesets on `main`**
   - No releasable changes means nothing to publish.
2. **The current `main` commit already has a canary**
   - The workflow is intentionally idempotent.
3. **Latest CI on `main` failed**
   - Canary publish is gated on the latest completed `checks.yaml` run succeeding.

Look for the canary summary in the workflow output. It should say which of those conditions caused the skip.

---

### Symptom: prerelease or dry run says there are no packages to release

Cause: the selected branch/ref has no publishable packages with pending changesets.

What to check:

1. Did you add a changeset on that branch?
2. Does the changeset mention one of the publishable JS packages?
3. Are you pointing the workflow at the correct branch or ref?

---

### Symptom: `Validate publishable package metadata` failed

Cause: one of the workspace package manifests does not match release expectations.

Common examples:

- a public package was accidentally marked `private`
- `publishConfig.access` is not `public`
- `publishConfig.registry` is not `https://registry.npmjs.org/`
- `repository.url` or `repository.directory` is wrong
- a package is publishable but missing required metadata such as `license`

Fix the relevant `package.json`, then rerun.

---

### Symptom: `Build publishable packages` failed

Cause: at least one publishable package did not build in CI.

Fix the build failure first. The release workflow only publishes packages after the build succeeds.

---

### Symptom: publish to npm failed

Likely causes:

- npm/trusted publishing configuration issue
- package metadata problem that npm rejects
- version conflict or registry-side publish issue

Check the failing `Publish ... to npm` step for the exact npm error.

---

### Symptom: tags or GitHub Releases were not created

For stable releases, those happen **after** npm publish.

If package publish worked but tags or releases did not, inspect these steps:

- `Push Changesets release tags`
- `Create GitHub Releases`

Those failures are usually GitHub permissions or API issues, not package build issues.

---

## FAQ

### Do I bump versions manually?

No. Changesets does that through the release PR or snapshot versioning in prerelease/canary flows.

### Do conventional commits control releases?

No. Changesets files control releases.

### Can I manually trigger a stable release from the workflow dispatch UI?

No. Stable release publishing happens from the push-to-`main` flow around the release PR.

### Can I publish a test build from a feature branch?

Yes. Use `release_mode=prerelease`.

### What is the difference between canary and prerelease?

- **canary**: automated or manual snapshot from `main`, published to `canary`
- **prerelease**: manual snapshot from any branch, published to `rc`

---

## Reference

- Publish workflow: `.github/workflows/publish-js-sdk.yaml`
- Canary scheduler workflow: `.github/workflows/publish-js-sdk-canary-scheduler.yaml`
- Release scripts: `scripts/release/*`
- Tag format: Changesets monorepo tags such as `braintrust@3.8.0` and `@braintrust/otel@0.3.0`
- Legacy `js-sdk-v<version>` tags are no longer created
