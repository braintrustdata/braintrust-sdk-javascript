# @braintrust/vercel-ai-sdk

> [!WARNING]
> This package and all of its exports are deprecated and will stop being
> published after the next release. Use the Vercel AI SDK integration in
> `braintrust` instead.

For manual instrumentation, use `wrapAISDK` from `braintrust`:

```ts
import * as ai from "ai";
import { wrapAISDK } from "braintrust";

const { generateText, streamText } = wrapAISDK(ai);
```

Braintrust also supports automatic AI SDK instrumentation. See the
[Braintrust SDK documentation](../../js/README.md#auto-instrumentation) for
runtime-hook and bundler setup.

The legacy `BraintrustAdapter` stream conversion helpers do not have a direct
replacement. Migrate those usages to `BraintrustStream` from `braintrust` and
the current AI SDK stream response APIs before this package stops being
published.
