# Publishing Packages

All package publishing happens in GitHub Actions. Do not publish from your local machine.

## Short Version

- If your PR changes a publishable package, add a `.changeset/*.md` file to it.
- Merge the PR into the branch you want to release.
- For a stable release:
  - Run **Prepare Release** from `main`. For a maintenance release, set `source_branch` (for example, `v3`).
  - Review the generated prepare release PR.
  - Run **Publish Release** with the `source_branch` and `release_sha` shown in the prepare workflow summary and leave `prerelease` unchecked.
  - Approve the `npm-publish` environment.
  - The publish workflow builds, packs, and attests the packages _before_ the gate, then (after approval) publishes from the exact commit SHA, creates tags and GitHub Releases for that commit, and comments on issues closed by released PRs.
  - Merge the prepare release PR after publishing succeeds.
- For a prerelease from a branch:
  - Run **Publish Release** with `release_sha=<full commit SHA to publish>` and `prerelease=true`.
  - Approve the `npm-publish` environment.
  - Install from the `rc` tag, for example `npm install braintrust@rc`.

## Changesets

If your PR changes a publishable package, CI expects a changeset unless you explicitly skip it.

To add one, have an agent follow [`.agents/skills/create-changeset/SKILL.md`](.agents/skills/create-changeset/SKILL.md), then commit the generated `.changeset/*.md` file with your PR.

If no release is intended, bypass the check with either:

- the `skip-changeset` PR label
- `#skip-changeset` in the PR title or body

## Stable Release

This is the normal production release flow.

1. Merge the changes into the source branch.
2. Run **Prepare Release** from `main`. Set `source_branch` to the branch you want to release. If you leave it empty, the workflow uses the branch selected in the Actions branch picker (normally `main`).
3. That workflow:
   - validates publishable package metadata
   - runs `changeset version`
   - creates a branch named `prepare-release/{source-branch}-{short-source-sha}`
   - opens a prepare release PR from that branch into the source branch
   - writes the `release_sha` to the workflow summary
4. Review the prepare release PR to confirm the package versions, changelogs, and consumed changeset deletions look right.
5. Run **Publish Release** from the same workflow branch with:
   - `release_sha=<full commit SHA to publish>`
   - the same `source_branch` as in the prepare workflow summary
   - `prerelease=false` (the default)
6. Approve the `npm-publish` environment when GitHub asks.
7. Merge the prepare release PR after publishing succeeds.

The stable publish workflow checks out `release_sha` exactly. It checks that the commit belongs to the source branch or is the version commit on its prepare release branch.

The workflow runs in stages, and the `npm-publish` approval gate sits _after_ the build so nothing is published until a reviewer approves:

1. **Build & pack (before the gate).** Checks the package versions at the release commit against npm and the Git release tags, builds them, packs the tarballs, generates an SBOM per package, and attests build provenance for the tarballs. If the manifest is empty, approval is skipped.
2. **Attest SBOMs.** Produces a signed attestation for each package's SBOM.
3. **Request approval.** Posts the release (SHA + package list) for review and waits on the `npm-publish` environment gate.
4. **Publish (after approval).** Publishes the prebuilt tarballs to the npm dist-tag shown in the approval request (skipping versions already on npm), pushes Changesets-style release tags for the release commit, creates GitHub Releases with the SBOM assets attached, and comments on issues closed by PRs included in the release.

The build/attest, approval, publish, and GitHub-release steps run through the shared release actions in [`braintrustdata/sdk-actions`](https://github.com/braintrustdata/sdk-actions) (pinned by commit SHA).

If publishing succeeds but the prepare release PR cannot be merged cleanly afterward, the release is still published. Repair or recreate the prepare release PR manually afterward.

Each stable package gets its own npm dist-tag, regardless of the source branch.
If npm’s `latest` tag points to a higher major, the package publishes to `latest-<package-major>`.
A first release, a release on the current major, or a new major publishes to `latest`.

For example, if `braintrust@latest` is 4.x and `@braintrust/otel@latest` is 1.x, the same release can publish `braintrust@3.45.0` to `latest-3` and `@braintrust/otel@1.2.0` to `latest`.
The approval manifest records each tag.
The workflow stops if the selected npm tag already points to a newer version.
If a new major changes a tag choice while approval is pending, start a new run to approve the updated tags.

Only stable releases from `main` are eligible for GitHub’s Latest release.
Each package version must still be unique across branches because npm dist-tags share the same package versions.

## Prerelease (`rc`)

Use this to publish a test build from a branch before merging to `main`.

1. Run **Publish Release**.
2. Set:
   - `release_sha=<full commit SHA to publish>`
   - `prerelease=true`
3. Approve the `npm-publish` environment after the build and attestation checks.
4. Wait for the workflow to finish.
5. Install from `rc`, for example:

```bash
npm install braintrust@rc
```

Prereleases:

- publish only packages with releasable changesets at that commit
- publish to the npm `rc` dist-tag
- create git tags and GitHub prereleases
- do not commit version changes back to the repo

## Notes

- For an older branch such as `v3`, run both workflows from `main` and enter `v3` for `source_branch`. This uses the workflows on `main` and the package code on `v3`.
- Both release types use `publish-stable-release.yaml`, the workflow configured for npm trusted publishing.
- Publishing must use a full 40-character commit SHA, not a PR number. In the normal prepare release flow, use the `release_sha` from the **Prepare Release** summary.
- The old `release` branch and backsync workflow are no longer part of the release process.
- Re-running **Publish Release** for the same `release_sha` is safe after a partial failure. Already-published npm versions are skipped, but tags and GitHub Releases are still reconciled for the prepared release set.
