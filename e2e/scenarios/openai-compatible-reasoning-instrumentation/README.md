# OpenAI-compatible streamed reasoning

These cassettes contain genuine `deepseek-flash` responses recorded through the real OpenAI SDK and the repository cassette harness on 2026-09-25. Requests went to `https://api.deepseek.com/v1/chat/completions`. The prompt, thinking settings and token limit are in `scenario.impl.mjs`; the ordered raw `reasoning_content` and ordinary content fragments remain in each cassette.

| Alias            | Installed SDK | Retained entry recorded at (UTC) | Reasoning fragments |
| ---------------- | ------------- | -------------------------------- | ------------------: |
| openai-v4        | 4.104.0       | 2026-09-25T06:11:56.615Z         |                  40 |
| openai-v4-latest | 4.104.0       | 2026-09-25T06:11:58.950Z         |                  42 |
| openai-v5        | 5.11.0        | 2026-09-25T06:12:01.499Z         |                  44 |
| openai-v5-latest | 5.23.2        | 2026-09-25T06:12:03.958Z         |                  39 |
| openai-v6        | 6.25.0        | 2026-09-25T06:12:07.000Z         |                  39 |
| openai-v6-latest | 6.49.0        | 2026-09-25T06:12:09.757Z         |                  49 |

The serial recording matrix makes twelve requests: wrapped, then auto-hook, for each of six aliases. The second run overwrites that alias's cassette, so six final auto-hook recordings are retained. Each is replayed through both entrypoints. `entry.recordedAt` identifies the retained response; `meta.createdAt` can refer to the earlier overwritten recording.

After recording, run the keyless snapshot update to align both entrypoints with the retained responses, then normal replay. Run these from the repository root:

```sh
pnpm --filter=@braintrust/js-e2e-tests run test:e2e:update -- openai-compatible-reasoning-instrumentation
pnpm --filter=@braintrust/js-e2e-tests run test:e2e -- openai-compatible-reasoning-instrumentation
```

Assertions independently concatenate the raw fragments per choice and check ordinary content before reasoning and snapshots. Retries are disabled, and the matrix stops at the first failure. The genuine responses cover one choice; constructed unit tests cover interleaved choices and absent, empty, null and malformed values.
