# seinfeld

Generic VCR/cassette library for Node.js, built on [MSW](https://mswjs.io). Record HTTP traffic on first run, replay deterministically forever after.

## Features

- **Normalizers** (always-on, lossy) transform requests before matching. They strip volatile fields like `Authorization` headers, dynamic IDs (`experimental_generateMessageId`), or query nonces so two structurally-identical requests still match across runs. Their output is internal — never serialized.
- **Redactors** (opt-in) transform what gets persisted to disk. They mask credentials before the cassette hits version control. Disabled by default; cassettes contain the real on-the-wire bytes unless you opt in.

## Security note

> **Cassettes contain real request and response bytes by default, including `Authorization` headers.** This is the safer default for fidelity (downstream consumers see real responses) but it means you must either (a) enable redaction, (b) write a custom `RedactionConfig`, or (c) add cassette files to `.gitignore` if they may contain credentials.

Three body-redaction gaps are worth knowing:

1. **Non-canonical content-type** — some servers return JSON with `Content-Type: text/plain`. `redactBodyFields` covers this because seinfeld attempts to parse `text` bodies as JSON before masking.
2. **SSE event data** — streaming endpoints (OpenAI, Anthropic) emit JSON in `data:` lines. `redactBodyFields` applies to parseable `data:` lines; `redactBodyText` handles non-JSON SSE content.
3. **Plain-text credentials** — form-encoded bodies, XML, or log-like text are opaque to field-path rules. Use `redactBodyText` with a regex.

For cassettes committed to version control, use the `'paranoid'` preset, which covers all three paths:

```ts
createCassette({ name: "demo", redact: "paranoid" });
```

`'paranoid'` redacts credential headers, common credential field names at any JSON depth (`apiKey`, `token`, `secret`, `password`, `authorization`), and Bearer / `sk-` style tokens in text bodies.

To detect misconfigurations at record time, add `strict: true`:

```ts
createCassette({
  name: "demo",
  redact: [
    "paranoid",
    { strict: true, redactBodyFields: ["messages.0.content"] },
  ],
});
```

With `strict: true`, any `redactHeaders` or `redactBodyFields` pattern that matches nothing across the cassette throws `CassetteRedactionError` — almost always a typo in a path or header name.

## Install

```bash
npm install --save-dev seinfeld
# pnpm add -D seinfeld
# yarn add -D seinfeld
```

Requires Node.js ≥ 18. MSW v2 is bundled.

## Quick start

```ts
import { createCassette, createJsonFileStore } from "seinfeld";

const cassette = createCassette({
  name: "openai-greeting",
  mode: process.env.SEINFELD_MODE === "record" ? "record" : "replay",
  store: createJsonFileStore({ rootDir: "./__cassettes__" }),
  filters: "default",
  redact: "paranoid",
});

await cassette.use(async () => {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  console.log(await res.json());
});
```

First run with `SEINFELD_MODE=record` hits the real network and writes `./__cassettes__/openai-greeting.cassette.json`. Subsequent runs (default `replay` mode) serve the recorded response with no network access.

## Modes

| Mode               | What happens                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `replay` (default) | Every outbound request must match a recorded entry. Misses throw `CassetteMissError`. Hermetic.          |
| `record`           | All requests reach the real network. The cassette file is fully overwritten with this run's entries.     |
| `passthrough`      | The library doesn't intercept. MSW is never started. Useful for nightly E2E runs against live endpoints. |

## Filters (matching pipeline)

Filters normalize requests before computing the match key. They affect matching only — the cassette retains the original request bytes.

```ts
createCassette({
  name: "demo",
  filters: {
    ignoreHeaders: ["authorization", /^x-/i],
    ignoreBodyFields: ["metadata.requestId", /^messages\.\d+\.id$/],
    ignoreQueryParams: ["nonce", /^_/],
    normalizeRequest: (req) => req, // arbitrary transform escape hatch
  },
});
```

Compose presets and configs in an array (applied in order):

```ts
filters: ["default", { ignoreBodyFields: ["custom.volatile"] }];
```

Built-in presets: `'default'` (auth + transport + rate-limit + user-agent headers), `'minimal'` (transport only), `'none'` (no-op).

## Redaction (persistence pipeline)

Off by default. For cassettes committed to version control, use `'paranoid'` (headers + common credential body fields + Bearer/`sk-` text patterns):

```ts
createCassette({ name: "demo", redact: "paranoid" });
```

`'aggressive'` is also available and covers only credential headers + cookies — use it when you want header-only coverage with no body side-effects.

Or specify granular rules:

```ts
createCassette({
  name: "demo",
  redact: {
    redactHeaders: ["authorization", "x-api-key"],
    redactBodyFields: ["user.email", "token"],
    redactQueryParams: ["api_key"],
    redactBodyText: [
      /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g, // plain regex → replaced with [REDACTED]
      { pattern: /sk-[A-Za-z0-9]{20,}/g }, // equivalent explicit form
      { pattern: /password=\S+/g, replacement: "password=HIDDEN" }, // custom replacement
    ],
    redactRequest: (req) => req, // function escape hatch (runs last)
    redactResponse: (res) => res,
  },
});
```

`redactBodyFields` applies to `json` bodies, and also to `text` bodies whose content is valid JSON (e.g., a server sending JSON with `Content-Type: text/plain`) and to JSON-bearing `data:` lines in `sse` bodies.

`redactBodyText` applies regex substitutions to `text` and `sse` bodies. Use it for credentials in non-JSON content (URL-encoded forms, XML, plain logs) and for SSE lines whose data is not JSON.

Compose presets and configs in an array (applied in order):

```ts
redact: ["paranoid", { redactBodyFields: ["user.email"] }];
```

Add `strict: true` to catch typos in your redaction rules at record time:

```ts
redact: { strict: true, redactHeaders: ['x-api-key'], redactBodyFields: ['token'] }
```

With `strict: true`, any header or body-field pattern that matches nothing across the cassette's entries throws `CassetteRedactionError` at save time.

Header values are masked with `[REDACTED]` (the header key is preserved so consumers can detect its presence). Body fields are masked the same way. Query parameters are deleted entirely (since `?key=[REDACTED]` would change URL semantics).

## Matching

The default matcher compares **method + URL + body**. Headers are not compared by default — filtering volatile headers is the normalizer's job, and other headers rarely affect request identity.

Repeated identical requests use a per-key call counter: the Nth call to a match key returns the Nth recorded entry. If you make more calls than were recorded, the last entry is reused.

Custom matchers receive the call counter and full filtered request:

```ts
import { createCassette, type Matcher } from "seinfeld";

const matchByModel: Matcher = {
  findMatch(req, candidates, callIndex) {
    return (
      candidates.find((c) => {
        const aBody = req.body as { value?: { model?: string } };
        const bBody = c.filtered.body as { value?: { model?: string } };
        return aBody.value?.model === bBody.value?.model;
      })?.entry ?? null
    );
  },
};

createCassette({ name: "demo", matcher: matchByModel });
```

## Vitest integration

`seinfeld/vitest` is a sub-path export with `setupCassettes`, which registers `beforeEach`/`afterEach` hooks to manage per-test cassettes:

```ts
// test/setup.ts
import { setupCassettes } from "seinfeld/vitest";
import { createJsonFileStore } from "seinfeld";

export const cassettes = setupCassettes({
  store: createJsonFileStore({ rootDir: "test/__cassettes__" }),
  filters: "default",
  mode: process.env.SEINFELD_MODE === "record" ? "record" : "replay",
});

// test/chat.test.ts
import { test, expect } from "vitest";
import "./setup";

test("chat completes", async () => {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    /* … */
  });
  expect(res.ok).toBe(true);
});
```

The cassette file path is auto-derived from the test name (e.g., `test/chat.test.ts > chat completes` → `test/__cassettes__/chat/chat-completes.cassette.json`). Override with `nameFor`:

```ts
setupCassettes({
  // ...
  nameFor: ({ testPath, testName }) => `custom/${slugify(testName)}`,
});
```

## Body encoding

Bodies are auto-detected by `content-type`:

| Content-type                                      | Stored as                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `application/json`, `*+json`                      | `{ kind: 'json', value: <parsed> }`                                                                  |
| `text/event-stream`                               | `{ kind: 'sse', chunks: [...] }` (split on `\n\n`)                                                   |
| `text/*`, XML, urlencoded                         | `{ kind: 'text', value: <utf-8> }`                                                                   |
| Binary ≥ `externalBlobThreshold` (default 64 KiB) | `{ kind: 'binary', path, sha256, contentType }` — bytes stored in a sidecar file beside the cassette |
| Binary < threshold (or absent content-type)       | `{ kind: 'base64', value: <b64>, contentType }`                                                      |
| Empty body                                        | `{ kind: 'empty' }`                                                                                  |

Round-trip is byte-exact for `text`, `base64`, `binary`, and `sse`. JSON is re-stringified compactly; whitespace is not preserved.

Set `externalBlobThreshold: false` on `CassetteOptions` to always inline as base64. Binary blob sidecar files live beside the cassette JSON at `<cassette-stem>.blobs/<sha256>.bin`.

## Cassette file format

```json
{
  "version": 1,
  "meta": {
    "createdAt": "2026-04-29T12:34:56.000Z",
    "seinfeldVersion": "0.1.0"
  },
  "entries": [
    {
      "id": "POST api.openai.com/v1/chat/completions #0",
      "matchKey": "POST api.openai.com/v1/chat/completions",
      "callIndex": 0,
      "recordedAt": "2026-04-29T12:34:56.000Z",
      "request": { "method": "POST", "url": "...", "headers": {...}, "body": {...} },
      "response": { "status": 200, "headers": {...}, "body": {...} }
    }
  ]
}
```

Cassettes use the `.cassette.json` extension by default so editors can apply schema rules. Format is versioned via the top-level `version` field; loading a cassette with a newer version than the library supports throws `CassetteVersionError`.

## Custom storage

The default `createJsonFileStore` writes cassettes to disk. Plug your own backend by implementing the two-method `CassetteStore` interface:

```ts
interface CassetteStore {
  load(name: string): Promise<Cassette | null>;
  save(name: string, cassette: Cassette): Promise<void>;
  list?(): Promise<string[]>;
}
```

`createMemoryStore()` is also exported and is useful for testing.

## Limitations

- **Streaming during record**: in `record` mode the recorder waits for the full response before returning to the caller. If your test depends on observing streaming behavior during recording (e.g., reading the first SSE chunk before the server finishes), you'll see all chunks at once instead. Replay streams normally.
- **JSON whitespace**: not preserved (see "Body encoding" above).
- **Subprocess recording**: not supported. The recorder runs in-process. Tests that spawn subprocesses won't have their HTTP traffic intercepted.
- **No automatic retries**: if a recording run gets a transient 429/5xx, the error is recorded as-is. Re-record manually.

## Development

```bash
pnpm install
pnpm test         # run tests
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm format       # prettier --write
pnpm build        # tsup → dist/
```

## License

MIT.
