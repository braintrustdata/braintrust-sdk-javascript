import type { CapturedLogEvent } from "./mock-braintrust-server";
import type { Json } from "./normalize";

export interface OpenAIScenario {
  scenarioPath: string;
  version: string;
}

const OPENAI_VERSIONS = [
  {
    suffix: "v4",
    version: "4.104.0",
  },
  {
    suffix: "v5",
    version: "5.11.0",
  },
  {
    suffix: "v6",
    version: "6.25.0",
  },
] as const;

export const OPENAI_SCENARIO_TIMEOUT_MS = 60_000;

export const OPENAI_AUTO_HOOK_SCENARIOS: OpenAIScenario[] = OPENAI_VERSIONS.map(
  ({ suffix, version }) => ({
    scenarioPath: `scenarios/openai-auto-instrumentation-node-hook.openai-${suffix}.mjs`,
    version,
  }),
);

export const WRAP_OPENAI_SCENARIOS: OpenAIScenario[] = OPENAI_VERSIONS.map(
  ({ suffix, version }) => ({
    scenarioPath: `scenarios/wrap-openai-conversation-traces.openai-${suffix}.ts`,
    version,
  }),
);

export function summarizeOpenAIContract(event: CapturedLogEvent): Json {
  const metadata = event.row.metadata as
    | {
        metadata?: { operation?: string };
        model?: string;
        openaiSdkVersion?: string;
        provider?: string;
        scenario?: string;
      }
    | undefined;

  return {
    has_input: event.input !== undefined && event.input !== null,
    has_output: event.output !== undefined && event.output !== null,
    metadata: {
      has_model: typeof metadata?.model === "string",
      openaiSdkVersion: metadata?.openaiSdkVersion ?? null,
      operation: metadata?.metadata?.operation ?? null,
      provider: metadata?.provider ?? null,
      scenario: metadata?.scenario ?? null,
    },
    metric_keys: Object.keys(event.metrics ?? {})
      .filter((key) => key !== "start" && key !== "end")
      .sort(),
    name: event.span.name ?? null,
    root_span_id: event.span.rootId ?? null,
    span_id: event.span.id ?? null,
    span_parents: event.span.parentIds,
    type: event.span.type ?? null,
  } satisfies Json;
}
