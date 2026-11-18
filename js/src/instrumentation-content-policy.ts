import iso from "#braintrust-platform";
import type { SpanExportData } from "./instrumentation/config";

/** Internal, dynamic privacy boundary for automatically instrumented descendants. */
export type InstrumentationContentPolicy = {
  allowed(): boolean;
  filterFramework(data: SpanExportData): SpanExportData;
};

const key = Symbol.for("braintrust.instrumentationContentPolicy");
const shared: typeof globalThis & {
  [key]?: ReturnType<
    typeof iso.newAsyncLocalStorage<InstrumentationContentPolicy>
  >;
} = globalThis;
const storage = () =>
  (shared[key] ??= iso.newAsyncLocalStorage<InstrumentationContentPolicy>());

export const currentInstrumentationContentPolicy = () => storage().getStore();
export function withInstrumentationContentPolicy<T>(
  policy: InstrumentationContentPolicy,
  call: () => T,
): T {
  return storage().run(policy, call);
}

export function filterInstrumentationContent(
  data: SpanExportData,
  policy: InstrumentationContentPolicy | undefined,
  instrumentation: string,
): SpanExportData {
  if (!policy || policy.allowed()) return data;
  if (instrumentation === "livekit") return policy.filterFramework(data);
  if (instrumentation === "braintrust-js-logger") return data;
  const { input: _input, output: _output, error: _error, ...safe } = data;
  if (data.metadata)
    safe.metadata = Object.fromEntries(
      Object.entries(data.metadata).filter(
        ([k]) =>
          k === "model" ||
          k === "provider" ||
          k === "requested_service_tier" ||
          k === "served_service_tier",
      ),
    );
  return safe;
}

export function withInheritedInstrumentationContentPolicy<T>(
  policy: InstrumentationContentPolicy | undefined,
  call: () => T,
): T {
  return policy && !currentInstrumentationContentPolicy()
    ? withInstrumentationContentPolicy(policy, call)
    : call();
}
