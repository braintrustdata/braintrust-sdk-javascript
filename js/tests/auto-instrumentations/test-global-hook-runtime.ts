import { build } from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeEntryPoint = fileURLToPath(
  new URL("../../src/global-instrumentation-hooks.ts", import.meta.url),
);

export async function buildTestGlobalHookRuntime(
  outputDirectory: string,
): Promise<string> {
  const outfile = path.join(
    outputDirectory,
    "global-instrumentation-hooks.cjs",
  );
  await build({
    bundle: true,
    entryPoints: [runtimeEntryPoint],
    format: "cjs",
    logLevel: "silent",
    outfile,
    platform: "node",
  });
  return outfile;
}
