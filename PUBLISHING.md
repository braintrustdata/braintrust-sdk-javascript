# Publishing Packages

All package publishing happens in GitHub Actions. Do not publish from your local machine.

## Short Version

- If your PR changes a publishable package, run `pnpm changeset` and commit the generated `.changeset/*.md` file.
- Merge the PR into `main`.
- For a stable release:
  - Run **Prepare Release** on `main`.
  - Review the generated prepare release PR, but do not merge it manually.
  - Run **Publish Stable Release** with the `release_pr` number shown in the prepare workflow summary.
  - Approve the `npm-publish` environment.
  - The publish workflow publishes from the exact prepare PR head commit, creates tags and GitHub Releases for that commit, then attempts to squash-merge the prepare PR into `main`.
- For a prerelease from a branch:
  - Run **Publish Prerelease Snapshot** with `ref=<branch, tag, or SHA>`.
  - Install from the `rc` tag, for example `npm install braintrust@rc`.

## Changesets

If your PR changes a publishable package, CI expects a changeset unless you explicitly skip it.

Create one with:

```bash
pnpm changeset
```

That creates a `.changeset/*.md` file. Commit it with your PR.

Use:

- `patch` for fixes and non-breaking maintenance changes
- `minor` for new backwards-compatible features
- `major` for breaking changes

If no release is intended, bypass the check with either:

- the `skip-changeset` PR label
- `#skip-changeset` in the PR title or body

## Stable Release (`latest`)

This is the normal production release flow.

1. Merge feature PRs into `main`.
2. Run **Prepare Release** from `main`.
3. That workflow:
   - validates publishable package metadata
   - runs `changeset version`
   - creates a branch named `prepare-release/{short-main-sha}`
   - opens a prepare release PR from that branch into `main`
   - writes the `release_pr` number to the workflow summary
4. Review the prepare release PR to confirm the package versions, changelogs, and consumed changeset deletions look right.
5. Run **Publish Stable Release** with:
   - `release_pr=<prepare release PR number>`
6. Approve the `npm-publish` environment when GitHub asks.

The stable publish workflow checks out the exact prepare PR head SHA. It does not publish from the current tip of `main`.

The workflow then:

- detects packages whose versions changed between the recorded `Source-main-sha` and the prepare PR head
- publishes any of those package versions that are not already on npm
- pushes Changesets-style release tags for the prepare PR head commit
- creates GitHub Releases
- attempts to squash-merge the prepare release PR into `main` with `--match-head-commit`

If publishing succeeds but the PR cannot be auto-merged, the release is still published. Merge or repair the prepare release PR manually afterward.

Stable releases publish to the npm `latest` dist-tag.

## Prerelease (`rc`)

Use this to publish a test build from a branch before merging to `main`.

1. Run **Publish Prerelease Snapshot**.
2. Set:
   - `ref=<branch, tag, or SHA>`
3. Wait for the workflow to finish.
4. Install from `rc`, for example:

```bash
npm install braintrust@rc
```

Prereleases:

- publish only packages with releasable changesets on that ref
- publish to the npm `rc` dist-tag
- do not create git tags
- do not create GitHub Releases
- do not commit version changes back to the repo

## Notes

- **Prepare Release** must be run from `main`.
- Stable publishing must use a prepare release PR created by **Prepare Release**.
- The old `release` branch and backsync workflow are no longer part of the release process.
- Re-running **Publish Stable Release** for the same `release_pr` is safe after a partial failure. Already-published npm versions are skipped, but tags and GitHub Releases are still reconciled for the prepared release set.
