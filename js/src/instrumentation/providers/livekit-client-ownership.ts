/* eslint-disable @typescript-eslint/consistent-type-assertions -- vendored client boundaries. */
import type {
  ModelService,
  OpenAIAdapterOptions,
} from "../../vendor-sdk-types/livekit";

type Kind = "llm" | "stt" | "tts";
type Ownership = { sdk: boolean; method: unknown; recognition?: unknown };
const key = Symbol.for("braintrust.livekit.clientOwnership");
const shared: typeof globalThis & {
  [key]?: WeakMap<object, Partial<Record<Kind, Ownership>>>;
} = globalThis;
const clients = () => (shared[key] ??= new WeakMap());

/** Public client/resource surfaces; neither SDK internals nor provider labels. */
function coveredClient(client: unknown, kind: Kind): boolean {
  if (!client || typeof client !== "object") return false;
  const sdk = client as {
    post?: unknown;
    withOptions?: unknown;
    chat?: { completions?: { create?: unknown } };
    messages?: { create?: unknown };
    audio?: {
      transcriptions?: { create?: unknown };
      speech?: { create?: unknown };
    };
  };
  const create =
    kind === "llm"
      ? (sdk.chat?.completions?.create ?? sdk.messages?.create)
      : kind === "stt"
        ? sdk.audio?.transcriptions?.create
        : sdk.audio?.speech?.create;
  return (
    typeof sdk.post === "function" &&
    typeof sdk.withOptions === "function" &&
    typeof create === "function"
  );
}

/** Observe the documented client option before any recognition/generation. */
export function recordLiveKitOpenAIClient(
  service: ModelService,
  constructor: { prototype?: ModelService },
  options: OpenAIAdapterOptions | undefined,
  kind: Kind,
): void {
  const method =
    kind === "llm" ? "chat" : kind === "stt" ? "recognize" : "synthesize";
  const record = clients().get(service) ?? {};
  if (record[kind]) return;
  record[kind] = {
    // The qualified public constructors default to the OpenAI SDK. A supplied
    // client is inspected directly, even if it implements the same wire format.
    sdk: options?.client ? coveredClient(options.client, kind) : true,
    method: constructor.prototype?.[method],
    ...(kind === "stt"
      ? { recognition: constructor.prototype?._recognize }
      : {}),
  };
  clients().set(service, record);
}

export function liveKitUsesCoveredClient(
  service: ModelService,
  kind: Kind,
  method: string,
  implementation?: unknown,
): boolean {
  const record = clients().get(service)?.[kind];
  if (record) {
    // Stock OpenAI STT.stream owns a WebSocket, independently of its SDK client.
    if (kind === "stt" && method === "stream") return false;
    if (
      record.method === implementation &&
      (kind !== "stt" || record.recognition === service._recognize)
    )
      return record.sdk;
    // A subclass overriding the operation owns its own client execution path.
  }
  return coveredClient(service.client, kind);
}
