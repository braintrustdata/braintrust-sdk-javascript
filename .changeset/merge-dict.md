---
"braintrust": patch
---

fix(security): reject `__proto__`, `constructor`, and `prototype` keys in `mergeDicts` / `mergeDictsWithPaths` to prevent prototype pollution from untrusted merge sources
