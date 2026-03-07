import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BraintrustSpanProcessor, setupOtelCompat } from "@braintrust/otel";
import { getContextManager, initLogger } from "braintrust";
import {
  createTracerProvider,
  getTestRunId,
  runMain,
  scopedName,
} from "./helpers";

async function main() {
  const testRunId = getTestRunId();
  setupOtelCompat();

  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);

  try {
    const processor = new BraintrustSpanProcessor({
      apiKey: process.env.BRAINTRUST_API_KEY!,
      apiUrl: process.env.BRAINTRUST_API_URL!,
      parent: `project_name:${scopedName("e2e-otel-compat-mixed-tracing", testRunId)}`,
    });
    const provider = createTracerProvider([processor]);
    trace.setGlobalTracerProvider(provider);

    const tracer = trace.getTracer("e2e-otel-compat");
    const logger = initLogger({
      projectName: scopedName("e2e-otel-compat-mixed-tracing", testRunId),
    });
    const btRoot = logger.startSpan({
      name: "bt-root",
      event: {
        metadata: {
          scenario: "otel-compat-mixed-tracing",
          testRunId,
        },
      },
    });
    const contextManagerFacade = getContextManager();

    await contextManagerFacade.runInContext(btRoot, async () => {
      await tracer.startActiveSpan("otel-middle", async (otelSpan) => {
        const btChild = logger.startSpan({
          name: "bt-child-under-otel",
          event: {
            metadata: {
              kind: "bt-child-under-otel",
              testRunId,
            },
          },
        });
        btChild.log({
          output: {
            source: "otel-child-context",
          },
        });
        btChild.end();
        otelSpan.end();
      });
    });
    btRoot.end();

    await logger.flush();
    await processor.forceFlush();
    await (provider as { shutdown?: () => Promise<void> }).shutdown?.();
  } finally {
    otelContext.disable();
    contextManager.disable();
  }
}

runMain(main);
