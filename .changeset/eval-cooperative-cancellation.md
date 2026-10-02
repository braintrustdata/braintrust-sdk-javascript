---
"braintrust": minor
---

feat(evals): Add cooperative cancellation via `signal` in task hooks

When an eval hits its `timeout` or its `signal` aborts, it now stops scheduling new trials, aborts the new `signal` in the task hooks, and waits for in-flight tasks and scorers to settle before rejecting. Previously the eval rejected right away and left running tasks going in the background. Pass `hooks.signal` to the APIs your task calls (or check `signal.aborted`) to stop work early.
