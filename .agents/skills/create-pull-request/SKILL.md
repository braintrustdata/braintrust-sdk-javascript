---
name: create-pull-request
description: Create or update GitHub pull requests for this repository with Conventional Commit titles aligned to their changeset summaries. Use whenever asked to open, create, draft, or retitle a pull request.
---

# Create a Pull Request

Inspect the branch diff and any changeset files added or modified by the branch before choosing the pull request title.
Use the GitHub CLI for GitHub operations.

## Title

The pull request title must follow Conventional Commits 1.0.0:

```text
<type>[optional scope][optional !]: <description>
```

Use `feat` for a feature and `fix` for a bug fix.
Other meaningful types such as `docs`, `test`, `refactor`, `build`, `ci`, and `chore` are allowed.
Use `!` immediately before the colon for a breaking change.
Keep the description concise and representative of the entire pull request.

If the branch contains a changeset whose first summary line accurately describes the pull request, reuse that line verbatim as the pull request title.
When the branch contains multiple changesets, prefer one shared Conventional Commit summary for all of them and the pull request title.
If intentionally distinct changeset summaries cannot share an accurate title, preserve their meaning and call out the mismatch rather than silently rewriting release notes.

If no changeset exists, derive a Conventional Commit title from the complete branch diff.
Reuse that exact title if a changeset is subsequently created for the same pull request.

Before creating or updating the pull request, run:

```bash
node scripts/release/validate-changesets.mjs
```

Do not create the pull request with a non-conforming title.
If the user supplied a non-conforming title, preserve its meaning while converting it to the required format and state the resulting title.
