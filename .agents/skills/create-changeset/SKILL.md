---
name: create-changeset
description: Create or update Changesets for this repository with a Conventional Commit summary aligned verbatim to the pull request title. Use whenever asked to add, create, edit, or fix a changeset.
---

# Create a Changeset

Inspect the diff to identify every publishable package affected and choose the appropriate semantic version bump for each package.
Use `pnpm changeset` when creating the changeset unless the existing task requires editing a specific changeset file.

## Summary

The first non-empty line after the changeset frontmatter must follow Conventional Commits 1.0.0:

```text
<type>[optional scope][optional !]: <description>
```

Use `feat` for a feature and `fix` for a bug fix.
Other meaningful types such as `docs`, `test`, `refactor`, `build`, `ci`, and `chore` are allowed.
Use `!` immediately before the colon for a breaking change.

Check whether the current branch already has a pull request with:

```bash
gh pr view --json title --jq .title
```

If a pull request exists and its title is a valid, accurate Conventional Commit message, use that title verbatim as the changeset's first summary line.
If its title is not conventional or does not accurately describe the release, do not create a conflicting summary; explain what needs to change before continuing.

If no pull request exists, derive one concise Conventional Commit summary from the diff.
Use the exact same summary for every changeset created for the branch, and preserve it verbatim as the title when the pull request is later created.

Additional release-note detail may follow on later lines.
Do not put introductory prose, a Markdown heading, or a list marker before the Conventional Commit summary.

After creating or editing the changeset, run:

```bash
node scripts/release/validate-changesets.mjs
```
