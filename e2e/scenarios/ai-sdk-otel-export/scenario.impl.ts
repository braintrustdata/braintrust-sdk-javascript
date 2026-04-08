import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BraintrustExporter } from "@braintrust/otel";
import {
  createTracerProvider,
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

interface AISDKOtelScenarioOptions {
  ai: {
    generateText: Function;
    streamText: Function;
    tool: Function;
    stepCountIs?: Function;
  };
  maxTokensKey: string;
  openai: (model: string) => unknown;
  sdkVersion: string;
  supportsToolExecution: boolean;
  toolSchemaKey: string;
  zod: { object: Function; string: Function; enum: Function };
}

function tokenLimit(key: string, value: number) {
  return { [key]: value };
}

export async function runAISDKOtelExport(options: AISDKOtelScenarioOptions) {
  const testRunId = getTestRunId();
  const projectName = scopedName("e2e-ai-sdk-otel-export", testRunId);

  const exporter = new BraintrustExporter({
    apiKey: process.env.BRAINTRUST_API_KEY!,
    apiUrl: process.env.BRAINTRUST_API_URL!,
    parent: `project_name:${projectName}`,
    filterAISpans: true,
  });

  const provider = createTracerProvider([new SimpleSpanProcessor(exporter)]);

  // Register the provider globally so AI SDK's experimental_telemetry uses it.
  const { trace } = await import("@opentelemetry/api");
  trace.setGlobalTracerProvider(provider);

  const model = options.openai("gpt-4o-mini-2024-07-18") as any;
  const telemetryBase = {
    isEnabled: true,
    metadata: {
      scenario: "ai-sdk-otel-export",
      sdkVersion: options.sdkVersion,
      testRunId,
    },
  };

  // --- generateText ---
  await options.ai.generateText({
    model,
    prompt: "Reply with the single token PARIS and no punctuation.",
    temperature: 0,
    ...tokenLimit(options.maxTokensKey, 24),
    experimental_telemetry: {
      ...telemetryBase,
      functionId: "otel-generate",
    },
  });

  // --- streamText ---
  const streamResult = await options.ai.streamText({
    model,
    prompt: "Count from 1 to 3 and include the words one two three.",
    temperature: 0,
    ...tokenLimit(options.maxTokensKey, 32),
    experimental_telemetry: {
      ...telemetryBase,
      functionId: "otel-stream",
    },
  });
  for await (const _chunk of streamResult.textStream) {
    // drain the stream
  }

  // --- tool use ---
  const z = options.zod as any;
  const weatherTool = options.ai.tool({
    description: "Get the weather for a location",
    [options.toolSchemaKey]: z.object({
      location: z.string().describe("The city and country"),
    }),
    execute: async (args: any) =>
      JSON.stringify({
        condition: "sunny",
        location: args.location,
        temperatureC: 22,
      }),
  });

  const toolRequest: any = {
    model,
    prompt:
      "Use the get_weather tool for Paris, France. If you do not call the tool, the answer is invalid.",
    system:
      "You must inspect live weather via the provided get_weather tool before responding.",
    temperature: 0,
    tools: { get_weather: weatherTool },
    ...tokenLimit(options.maxTokensKey, 128),
    experimental_telemetry: {
      ...telemetryBase,
      functionId: "otel-tool",
    },
  };

  if (options.supportsToolExecution && options.ai.stepCountIs) {
    toolRequest.toolChoice = "required";
    toolRequest.stopWhen = options.ai.stepCountIs(4);
  }

  await options.ai.generateText(toolRequest);

  // Flush and shutdown
  await exporter.forceFlush();
  await (provider as { shutdown?: () => Promise<void> }).shutdown?.();

  // Small delay to allow HTTP requests to complete
  await new Promise((resolve) => setTimeout(resolve, 500));
}
