# Publishing JavaScript SDK Packages

All JavaScript package publishing happens in GitHub Actions. Do not publish from your local machine.

## Short Version

- If your PR changes a publishable package, run `pnpm changeset` and commit the generated `.changeset/*.md` file.
- Merge the PR into `main`.
- For a stable release:
  - Run **Prepare Release** on `main`.
  - Merge the generated PR into `release`.
  - Run **Release Packages** with `release_mode=stable` and `ref=release`.
  - Approve the `npm-publish` environment.
  - The backsync workflow enables auto-merge on the backsync PR; approve it only after the publish succeeds.
- For a prerelease from a branch:
  - Run **Release Packages** with `release_mode=prerelease` and `ref=<branch>`.
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

1. Merge the feature PR into `main`.
2. Run **Prepare Release** from `main`.
3. That workflow:
   - runs `changeset version`
   - creates a branch named `release/{short-main-sha}`
   - opens a PR from that branch into `release`
4. Review and merge that PR into `release`.
5. Run **Release Packages** with:
   - `release_mode=stable`
   - `ref=release`
6. Approve the `npm-publish` environment when GitHub asks.
7. The backsync workflow opens a PR from `backsync/{short-release-sha}` to `main` and enables auto-merge on it.
8. After the publish succeeds, approve that backsync PR so it can merge into `main`.

Stable releases publish to the npm `latest` dist-tag, push release tags, and create GitHub Releases.

## Prerelease (`rc`)

Use this to publish a test build from a branch before merging to `main`.

1. Run **Release Packages**.
2. Set:
   - `release_mode=prerelease`
   - `ref=<branch, tag, or SHA>`
3. Wait for the workflow to finish.
4. Install from `rc`, for example:

```bash
npm install braintrust@rc
```

Prereleases:

- publish only packages with releasable changesets on that ref
- do not create git tags
- do not create GitHub Releases
- do not commit version changes back to the repo

## Notes

- **Prepare Release** must be run from `main`.
- `release` is the branch used for stable publishing.
- The backsync PR is opened when `release` gets the release commit, not after publish, and the workflow enables auto-merge on it. Because `main` requires an approving review, do not approve that PR until the stable publish succeeds.
