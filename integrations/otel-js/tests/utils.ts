/* eslint-disable @typescript-eslint/no-explicit-any */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const uint8Array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    uint8Array[i] = binary.charCodeAt(i);
  }
  return uint8Array;
}

export function getExportVersion(exportedSpan: string): number {
  const exportedBytes = base64ToUint8Array(exportedSpan);
  return exportedBytes[0];
}

/**
 * Create a BasicTracerProvider with span processors in a way that works with both OTel 1.x and 2.x.
 *
 * In OTel 1.x: Uses addSpanProcessor() method (constructor config doesn't work properly)
 * In OTel 2.x: Uses constructor config with spanProcessors (addSpanProcessor removed)
 *
 * This helper detects which API is available and uses the correct approach.
 */
export function createTracerProvider(
  ProviderClass: any,
  processors: any[],
  config?: any,
): any {
  // Create a test provider to detect which API version we're using
  const testProvider = new ProviderClass(config || {});

  if (typeof testProvider.addSpanProcessor === "function") {
    // OTel 1.x: Has addSpanProcessor method
    const provider = new ProviderClass(config);
    for (const processor of processors) {
      provider.addSpanProcessor(processor);
    }
    return provider;
  } else {
    // OTel 2.x: Must use constructor config
    const provider = new ProviderClass({
      ...config,
      spanProcessors: processors,
    });
    return provider;
  }
}

/**
 * Get parent span ID from a ReadableSpan in a version-agnostic way.
 *
 * In OTel 1.x: ReadableSpan has parentSpanId property
 * In OTel 2.x: ReadableSpan has parentSpanContext.spanId property
 *
 * @param span The span to extract parent ID from
 * @returns The parent span ID, or undefined if not present
 */
export function getParentSpanId(span: any): string | undefined {
  // Try OTEL v1 format first (parentSpanId)
  if (span.parentSpanId) {
    return span.parentSpanId;
  }

  // Try OTEL v2 format (parentSpanContext.spanId)
  if (span.parentSpanContext && span.parentSpanContext.spanId) {
    return span.parentSpanContext.spanId;
  }

  return undefined;
}

import path from "path";
import fs from "fs";

/**
 * Detect if we're in v1 or v2 based on the calling directory.
 */
export function detectOtelVersion(cwd: string): "v1" | "v2" | "parent" {
  const isV1 = cwd.includes("otel-v1");
  const isV2 = cwd.includes("otel-v2");
  return isV1 ? "v1" : isV2 ? "v2" : "parent";
}

/**
 * Log OpenTelemetry package versions for the current test environment.
 * Only logs for v1/v2 test directories, not the parent package.
 */
export function logOtelVersions(version: "v1" | "v2" | "parent"): void {
  if (version === "parent") {
    return;
  }

  console.log(`\n=== OpenTelemetry Versions (${version}) ===`);
  const packages = [
    "@opentelemetry/api",
    "@opentelemetry/core",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/otlp-transformer",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/resources",
  ];

  packages.forEach((pkg) => {
    try {
      let pkgPath;
      try {
        pkgPath = require.resolve(`${pkg}/package.json`);
      } catch {
        const pkgMainPath = require.resolve(pkg);
        let dir = path.dirname(pkgMainPath);
        while (dir !== path.dirname(dir)) {
          const testPath = path.join(dir, "package.json");
          if (fs.existsSync(testPath)) {
            const testJson = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            if (testJson.name === pkg) {
              pkgPath = testPath;
              break;
            }
          }
          dir = path.dirname(dir);
        }
      }
      if (pkgPath) {
        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        console.log(`  ${pkg}:`, pkgJson.version);
      } else {
        console.log(`  ${pkg}: NOT FOUND`);
      }
    } catch {
      console.log(`  ${pkg}: NOT FOUND`);
    }
  });
  console.log("===================================\n");
}

/**
 * Create OpenTelemetry package aliases for v1/v2 test environments.
 * This forces resolution to stay within each test package's node_modules,
 * which is critical for testing with different OpenTelemetry versions.
 */
export function createOtelAliases(cwd: string): Record<string, string> {
  const repositoryRoot =
    detectOtelVersion(cwd) === "parent"
      ? path.resolve(cwd, "../..")
      : path.resolve(cwd, "../../..");
  return {
    "@braintrust/otel": path.resolve(
      repositoryRoot,
      "integrations/otel-js/src/index.ts",
    ),
    "braintrust/instrumentation": path.resolve(
      repositoryRoot,
      "js/src/instrumentation/index.ts",
    ),
    braintrust: path.resolve(repositoryRoot, "js/src/node/index.ts"),
    "@opentelemetry/api": path.resolve(cwd, "node_modules/@opentelemetry/api"),
    "@opentelemetry/core": path.resolve(
      cwd,
      "node_modules/@opentelemetry/core",
    ),
    "@opentelemetry/sdk-trace-base": path.resolve(
      cwd,
      "node_modules/@opentelemetry/sdk-trace-base",
    ),
    "@opentelemetry/resources": path.resolve(
      cwd,
      "node_modules/@opentelemetry/resources",
    ),
    "@opentelemetry/exporter-trace-otlp-http": path.resolve(
      cwd,
      "node_modules/@opentelemetry/exporter-trace-otlp-http",
    ),
    "@opentelemetry/context-async-hooks": path.resolve(
      cwd,
      "node_modules/@opentelemetry/context-async-hooks",
    ),
    "@opentelemetry/sdk-node": path.resolve(
      cwd,
      "node_modules/@opentelemetry/sdk-node",
    ),
  };
}
