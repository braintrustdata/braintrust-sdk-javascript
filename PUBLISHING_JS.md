# Publishing JavaScript SDK Packages

This guide explains how to release packages from this repository.

**Important:** all publishing happens in **GitHub Actions**. Do **not** publish from your local machine.

## TL;DR

- Run `pnpm changeset` in any PR that contains changes that may in any way be user facing
- Commit the generated `.changeset/*.md` file
- Merging your PR will update or create a "Release PR"
- Merging the "Release PR" will trigger a release
- Release runs need to be approved on GitHub via Deployment Approvals

## Start here

| I want to...                                           | What to do                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Make my PR release something                           | Run `pnpm changeset` and commit the generated `.changeset/*.md` file                      |
| Ship a normal stable release to npm `latest`           | Merge the auto-created release PR on `main`, then approve the `npm-publish` environment   |
| Publish a branch build for testing                     | Run the **Release Packages** workflow with `release_mode=prerelease` and your branch name |
| Manually trigger a canary publish                      | Run the **Release Packages** workflow with `release_mode=canary`                          |
| Preview what would publish without actually publishing | Run the workflow with a `dry-run-*` mode                                                  |

## Creating a Changeset

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

If your PR touches a publishable package but does not contain any potentially user-facing or user-impacting changes, bypass the check by using one of these:

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

### Prerelease version format

```text
1.2.3-rc.20260414104840.abcdef1234567890abcdef1234567890abcdef12
```

That includes:

- the next base version
- a timestamp
- the commit SHA

### What prereleases do not do

- do not create git tags
- do not create GitHub Releases
- do not commit version changes back to the repo
- do not publish packages that have no releasable changesets on that branch

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

## FAQ

### Can I manually trigger a stable release from the workflow dispatch UI?

No. Stable release publishing happens from the push-to-`main` flow around the release PR.

### Can I publish a test build from a feature branch?

Yes. Use `release_mode=prerelease` and a specific branch ref.

### What is the difference between canary and prerelease?

- **canary**: automated or manual snapshot from `main`, published to `canary`
- **prerelease**: manual snapshot from any branch, published to `rc`
