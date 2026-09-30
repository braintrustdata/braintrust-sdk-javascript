---
"braintrust": minor
---

feat: Add `projectGroupName` to create projects inside a project group

`initLogger`, `init`, `initDataset`, and `Eval` now accept `projectGroupName`. When the named project does not exist yet, it is created inside that project group, which lets callers who only hold project-creation permission on a group (rather than on the whole organization) register projects. The option is ignored when a `projectId` is supplied.
