import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/workflow-interceptors.ts"],
    format: ["cjs", "esm"],
    outDir: "dist",
    external: [
      "braintrust",
      "@braintrust/temporal/workflow-interceptors",
      "@temporalio/activity",
      "@temporalio/client",
      "@temporalio/common",
      "@temporalio/worker",
      "@temporalio/workflow",
    ],
    dts: true,
  },
]);
