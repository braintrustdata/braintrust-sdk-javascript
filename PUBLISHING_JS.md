# Publishing JavaScript SDK Packages

> **TL;DR** — Add a changeset to your PR. For stable releases, merge the auto-created release PR. For prereleases, trigger the workflow manually. Everything publishes via GitHub Actions — never from a laptop.

---

## Quick Reference

| I want to…                         | Do this                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Flag my PR for release             | Run `pnpm changeset` and commit the generated file                                |
| Ship a stable release              | Merge the release PR on `main` → approve the `npm-publish` environment            |
| Publish a prerelease from a branch | Trigger workflow manually with `release_mode=prerelease`                          |
| Get the latest canary build        | `npm install braintrust@canary` (published nightly from `main`)                   |
| Trigger a canary manually          | Trigger workflow manually with `release_mode=canary`                              |
| Preview what would publish         | Trigger workflow with `dry-run-stable`, `dry-run-prerelease`, or `dry-run-canary` |

---

## Packages

This process covers all public JS SDK packages:

`braintrust` · `@braintrust/browser` · `@braintrust/langchain-js` · `@braintrust/openai-agents` · `@braintrust/otel` · `@braintrust/templates-nunjucks-js` · `@braintrust/temporal` · `@braintrust/vercel-ai-sdk`

---

## Step 0: Add a Changeset to Your PR

**CI enforces this.** If your PR touches files in a publishable package, the `changeset-required` check will fail unless you include a changeset.

```bash
pnpm changeset
```

You'll be prompted to pick:

- **Which packages** are affected
- **Bump type** — major / minor / patch
- **Changelog entry** — a short description of the change

Commit the generated `.changeset/*.md` file with your PR.

### Choosing the right bump type

When `pnpm changeset` asks for a bump type, use these guidelines:

| Bump type | When to use                                                                                                                                                                                           | Examples                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **patch** | Bug fixes, internal refactors, performance improvements, docs fixes, or dependency updates that don't change the public API.                                                                          | Fix a crash in `span.end()`, update an internal retry policy, bump a transitive dep                                             |
| **minor** | New features, new exports, new optional parameters, or new integrations — anything that **adds** functionality without breaking existing usage.                                                       | Add a new `flush()` method, expose a new `@braintrust/foo` integration, add an optional `timeout` param to an existing function |
| **major** | Breaking changes — removing or renaming public API surface, changing default behavior, dropping support for a Node version, or anything that could require users to update their code when upgrading. | Rename `logger.log()` → `logger.trace()`, remove a deprecated export, change a function's return type                           |

> **When in doubt, pick `patch`.** It's easy to upgrade a changeset's bump type during review, and most changes are patches. Over-bumping causes unnecessary major versions that make life harder for consumers.

### What the generated file looks like

Running `pnpm changeset` creates a Markdown file in `.changeset/` (e.g. `.changeset/funny-dogs-dance.md`):

```markdown
---
"braintrust": patch
---

Fix span export when using custom headers
```

The frontmatter lists each affected package and its bump type. The body becomes the changelog entry. You can edit this file by hand after generation — for example, to adjust the bump type, tweak the description, or add multiple packages.

### Tips

- **One changeset per logical change.** If your PR does two unrelated things (e.g. fixes a bug _and_ adds a feature), create two changesets so each gets its own changelog entry.
- **Multiple packages in one changeset is fine.** If a single change affects both `braintrust` and `@braintrust/otel`, pick both when prompted — they'll share one changeset file.
- **You can run `pnpm changeset` multiple times** to add more changeset files to the same PR.

### When you DON'T need a changeset

If your PR doesn't touch publishable package code (e.g. docs-only, test-only, CI changes), the check passes automatically.

If your PR touches a publishable package but **shouldn't trigger a release**, bypass the check with any of:

- Add the **`skip-changeset`** label to the PR
- Include `#skip-changeset` in the PR title or body

---

## Stable Release (publish to `latest` on npm)

### How it works

```
PR with changeset → merges to main → bot opens release PR → you merge release PR → publish
```

### Step-by-step

1. **Merge your PR** (with changeset) into `main`.
2. **GitHub Actions automatically creates/updates a release PR** that contains version bumps, changelog updates, and lockfile changes.
3. **Review the release PR.** Check:
   - Are the version bumps correct (major/minor/patch)?
   - Do the changelog entries look right?
4. **Merge the release PR.**
5. **Approve the publish.** The workflow pauses at the `npm-publish` environment gate — click "Approve" in the Actions UI.
6. **Done.** Packages are published to npm, git tags are created (e.g. `braintrust@3.8.0`), and GitHub Releases are generated.

### No release PR showing up?

- No unreleased changesets exist on `main`.
- The workflow hasn't run yet (check Actions).
- The previous release PR was already merged and there's nothing new.

---

## Canary (publish to `canary` on npm)

Canary builds are **automated nightly snapshots** from `main`. They let users test the latest merged changes without waiting for a formal release.

### How it works

```
Nightly cron (04:00 UTC) → check for pending changesets → check if HEAD already has canary → publish
```

- Runs automatically every night at 04:00 UTC.
- **Skips** if there are no pending changesets on `main`.
- **Skips** if the current `HEAD` commit already has a canary published (idempotent).
- Can also be triggered manually via workflow dispatch with `release_mode=canary`.

### Installing a canary build

```bash
npm install braintrust@canary
npm install @braintrust/otel@canary
```

### Canary version format

Canary versions include the snapshot tag, a datetime stamp, and the short commit hash:

```
1.2.3-canary.20260404040000.abc1234
```

This makes versions monotonically increasing and traceable to a specific commit.

### What canaries do NOT do

- ❌ Create git tags
- ❌ Create GitHub Releases
- ❌ Commit version changes back to the repo
- ❌ Require manual approval — canaries publish automatically
- ❌ Affect the release PR or stable release flow

---

## Prerelease (publish to `rc` on npm)

Use this to publish a testable build from **any branch** — no need to merge to `main` first.

### Step-by-step

1. Go to **Actions → "Release Packages"** workflow in GitHub.
2. Click **"Run workflow"** and set:
   - **`release_mode`** → `prerelease`
   - **`branch`** → the branch you want to publish (e.g. `my-feature`)
3. Click **"Run workflow"**.
4. Once complete, install with the `rc` tag:
   ```bash
   npm install braintrust@rc
   ```

### What prereleases do NOT do

- ❌ Create git tags
- ❌ Create GitHub Releases
- ❌ Commit version changes back to the repo
- ❌ Publish the entire workspace — only packages with releasable changesets on the branch

---

## Dry Run (preview without publishing)

Trigger the workflow manually with one of:

| Mode                 | What it simulates |
| -------------------- | ----------------- |
| `dry-run-stable`     | A stable release  |
| `dry-run-prerelease` | A prerelease      |
| `dry-run-canary`     | A canary release  |

You'll see which packages would release, the computed versions, and packaged tarballs — but **nothing is published, tagged, or committed**.

---

## FAQ

**Do I need to bump versions manually?**
No. Changesets handles it via the release PR.

**Do conventional commits drive releases?**
No. Only changeset files drive releases.

**Can I publish a prerelease from a feature branch?**
Yes. That's exactly what prereleases are for.

**Is canary publishing supported?**
Yes. Canaries are published nightly from `main` to the `canary` npm dist-tag. You can also trigger one manually via workflow dispatch.

**What's the difference between canary and prerelease?**
Canaries are **automated nightly** from `main` (tagged `canary`). Prereleases are **manual** from any branch (tagged `rc`).

---

## Reference

- **Workflow file:** `.github/workflows/publish-js-sdk.yaml`
- **Tag format:** Standard Changesets monorepo tags (e.g. `braintrust@3.8.0`, `@braintrust/otel@0.3.0`). Legacy `js-sdk-v<version>` tags are no longer created.
- **Trusted publishing:** If npm trusted publishing is configured for additional packages, point npm at the workflow file above.
