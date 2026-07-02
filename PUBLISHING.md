# Publishing Packages

All package publishing happens in GitHub Actions. Do not publish from your local machine.

## Short Version

- If your PR changes a publishable package, run `pnpm changeset` and commit the generated `.changeset/*.md` file.
- Merge the PR into `main`.
- For a stable release:
  - Run **Prepare Release** on `main`.
  - Review the generated prepare release PR.
  - Run **Publish Stable Release** with the `release_sha` shown in the prepare workflow summary.
  - Approve the `npm-publish` environment.
  - The publish workflow publishes from the exact commit SHA, creates tags and GitHub Releases for that commit, and comments on issues closed by released PRs.
  - Merge the prepare release PR after publishing succeeds.
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
   - writes the `release_sha` to the workflow summary
4. Review the prepare release PR to confirm the package versions, changelogs, and consumed changeset deletions look right.
5. Run **Publish Stable Release** with:
   - `release_sha=<full commit SHA to publish>`
6. Approve the `npm-publish` environment when GitHub asks.
7. Merge the prepare release PR after publishing succeeds.

The stable publish workflow checks out `release_sha` exactly. It accepts any full commit SHA with a parent, does not resolve the prepare release PR, and does not publish from the current tip of `main`.

The workflow then:

- detects packages whose versions changed between the release commit and its first parent
- publishes any of those package versions that are not already on npm
- pushes Changesets-style release tags for the release commit
- creates GitHub Releases
- comments on issues closed by PRs included in the release

If publishing succeeds but the prepare release PR cannot be merged cleanly afterward, the release is still published. Repair or recreate the prepare release PR manually afterward.

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
- Stable publishing must use a full 40-character commit SHA, not a PR number. In the normal prepare release flow, use the `release_sha` from the **Prepare Release** summary.
- The old `release` branch and backsync workflow are no longer part of the release process.
- Re-running **Publish Stable Release** for the same `release_sha` is safe after a partial failure. Already-published npm versions are skipped, but tags and GitHub Releases are still reconciled for the prepared release set.
