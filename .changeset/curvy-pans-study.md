---
"braintrust": patch
---

fix: Make `@types/react` an optional peer dependency

`braintrust` no longer installs React 18 types for every consumer. Projects that use `braintrust/custom-views` now type-check against their own `@types/react` (React 18 or newer), which fixes `ReactNode` type conflicts in React 19 projects.
