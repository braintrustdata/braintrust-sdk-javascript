import { BraintrustExporter } from "@braintrust/otel";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { initLogger } from "braintrust";

type Runtime = "edge" | "nodejs";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

export function getTestRunId(): string {
  return requiredEnv("BRAINTRUST_E2E_RUN_ID");
}

export function scopedName(base: string): string {
  const suffix = getTestRunId()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `${base}-${suffix}`;
}

function createTracerProvider(processors: unknown[]) {
  if (
    typeof (new BasicTracerProvider() as { addSpanProcessor?: unknown })
      .addSpanProcessor === "function"
  ) {
    const provider = new BasicTracerProvider() as {
      addSpanProcessor: (processor: unknown) => void;
      getTracer: (name: string) => {
        startActiveSpan: (
          name: string,
          callback: (span: {
            end: () => void;
            setAttribute: (key: string, value: string) => void;
          }) => Promise<void> | void,
        ) => Promise<void>;
      };
      shutdown?: () => Promise<void>;
    };
    processors.forEach((processor) => provider.addSpanProcessor(processor));
    return provider;
  }

  return new BasicTracerProvider({
    spanProcessors: processors as never,
  }) as {
    getTracer: (name: string) => {
      startActiveSpan: (
        name: string,
        callback: (span: {
          end: () => void;
          setAttribute: (key: string, value: string) => void;
        }) => Promise<void> | void,
      ) => Promise<void>;
    };
    shutdown?: () => Promise<void>;
  };
}

async function emitOtelSpan(runtime: Runtime, testRunId: string) {
  const exporter = new BraintrustExporter({
    apiKey: requiredEnv("BRAINTRUST_API_KEY"),
    apiUrl: requiredEnv("BRAINTRUST_API_URL"),
    parent: `project_name:${scopedName("e2e-nextjs-instrumentation")}`,
    filterAISpans: false,
  });

  const provider = createTracerProvider([new SimpleSpanProcessor(exporter)]);
  trace.setGlobalTracerProvider(provider as never);

  await provider
    .getTracer("nextjs-instrumentation-e2e")
    .startActiveSpan(`nextjs ${runtime} otel span`, async (span) => {
      span.setAttribute("runtime", runtime);
      span.setAttribute("scenario", "nextjs-instrumentation");
      span.setAttribute("testRunId", testRunId);
      span.end();
    });

  await exporter.forceFlush();
  await provider.shutdown?.();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export async function runRuntimeCheck(runtime: Runtime) {
  const testRunId = getTestRunId();
  const projectName = scopedName(`e2e-nextjs-instrumentation-${runtime}`);
  const loggerSpanName = `nextjs ${runtime} logger span`;
  const otelSpanName = `nextjs ${runtime} otel span`;
  const route = `/api/smoke-test/${runtime === "nodejs" ? "node" : runtime}`;
  const metadata = {
    runtime,
    scenario: "nextjs-instrumentation",
    testRunId,
    transport: "http",
  };

  const logger = initLogger({ projectName });

  await logger.traced(
    async (rootSpan) => {
      rootSpan.log({
        input: {
          route,
          runtime,
        },
        metadata,
        output: {
          ok: true,
          route,
          runtime,
        },
      });
    },
    {
      name: loggerSpanName,
      event: {
        input: {
          route,
          runtime,
        },
        metadata,
      },
    },
  );

  await logger.flush();

  await emitOtelSpan(runtime, testRunId);

  return {
    instrumentationRegistered: Boolean(
      (globalThis as { __btNextjsInstrumentationRegistered?: boolean })
        .__btNextjsInstrumentationRegistered,
    ),
    loggerSpanName,
    otelSpanName,
    projectName,
    route,
    runtime,
    success: true,
    testRunId,
  };
}

export function formatRouteError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: String(error),
    name: "UnknownError",
  };
}
