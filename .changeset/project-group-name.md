---
"braintrust": minor
---

feat: Add `projectGroupName` to create projects inside a project group

`projects.create({ name, projectGroupName })` now accepts a project group name. When `braintrust push` or `project.publish()` registers a project that does not exist yet, it is created inside that project group, which lets callers who only hold project-creation permission on a group (rather than on the whole organization) register projects.
