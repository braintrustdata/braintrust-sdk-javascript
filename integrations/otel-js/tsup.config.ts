import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    outDir: "dist",
    external: [
      "braintrust",
      "@opentelemetry/api",
      "@opentelemetry/core",
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/context-async-hooks",
    ],
    define: {
      __BRAINTRUST_OTEL_VERSION__: JSON.stringify(packageJson.version),
    },
    dts: true,
  },
]);
