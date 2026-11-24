# LiveKit client ownership: problem and proposal

LiveKit's STT, LLM, and TTS operations are framework task spans. Actual OpenAI
SDK calls belong to Braintrust's OpenAI integration; LiveKit-owned HTTP or
WebSocket calls need separate `livekit.*` model spans under those tasks. Turning
OpenAI instrumentation off must leave SDK calls without replacement model spans.

The OpenAI plugin accepts a public `client` constructor option, but stores its
clients privately. Looking at the provider name or adapter method source cannot
distinguish the default SDK client from an injected HTTP client. Missing provider
spans are also insufficient: the integration might simply be disabled.

Proposed implementation, included locally for review:

- Observe the OpenAI plugin's public constructors and supplied client options.
  Keep ownership separately from provider tracing activation. Classify SDK clients
  from their public client/resource API; do not inspect private fields or source.
- Automatic instrumentation observes construction through the normal invocation
  hooks. Manual instrumentation also wraps the plugin module before construction:

  ```ts
  const agents = wrapLiveKit(await import("@livekit/agents"));
  const openai = wrapLiveKit(await import("@livekit/agents-plugin-openai"));
  const client = wrapOpenAI(new OpenAI());
  const session = new agents.voice.AgentSession({
    stt: new openai.STT({ client }),
  });
  ```

  Users still enable/wrap OpenAI instrumentation alongside LiveKit for SDK model
  spans. Wrapping the plugin records ownership; it does not activate OpenAI tracing.

- Preserve direct WebSocket STT as LiveKit-owned. Do not apply a base adapter's
  ownership to a subclass that replaces its operation.

Tradeoff: manual users need an additional module-wrapping call, before creating
adapters. Adapters created earlier cannot be classified reliably afterward.
This qualifies the OpenAI cascade plugin; other plugins need their own documented
client/operation boundary, rather than a provider-name allowlist.

Alternative: ask LiveKit for a public per-operation client/transport ownership
accessor. That could preserve `wrapLiveKit(agents)` as the only manual entrypoint
and remove constructor interception, but requires an upstream change.

Feedback requested: is the extra manual wrapping call acceptable, or should we
coordinate the upstream accessor before shipping this ownership behavior?
