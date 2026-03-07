import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

export async function collectAsync<T>(records: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const record of records) {
    items.push(record);
  }
  return items;
}

export function getTestRunId(): string {
  return process.env.BRAINTRUST_E2E_RUN_ID!;
}

export function scopedName(base: string, testRunId = getTestRunId()): string {
  const suffix = testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${base}-${suffix}`;
}

export function createTracerProvider(processors: unknown[]) {
  const testProvider = new BasicTracerProvider();

  if (
    typeof (testProvider as { addSpanProcessor?: unknown }).addSpanProcessor ===
    "function"
  ) {
    const provider = new BasicTracerProvider() as BasicTracerProvider & {
      addSpanProcessor: (processor: unknown) => void;
    };
    processors.forEach((processor) => provider.addSpanProcessor(processor));
    return provider;
  }

  return new BasicTracerProvider({
    spanProcessors: processors as never,
  });
}

export function runMain(main: () => Promise<void>): void {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
