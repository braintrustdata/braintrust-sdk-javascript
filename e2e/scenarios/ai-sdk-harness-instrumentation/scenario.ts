import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { braintrustAISDKTelemetry, wrapAgentClass } from "braintrust";
import { runHarnessAgentScenario } from "./scenario.impl.mjs";

const harnessPackageName =
  process.env.AI_SDK_HARNESS_PACKAGE_NAME ?? "ai-sdk-harness-v1-latest";
const harnessAgentUrl = import.meta.resolve(`${harnessPackageName}/agent`);
const harnessRequire = createRequire(harnessAgentUrl);
const { registerTelemetry } = await import(
  pathToFileURL(harnessRequire.resolve("ai")).href
);
const { HarnessAgent } = await import(harnessAgentUrl);

registerTelemetry(braintrustAISDKTelemetry());

await runHarnessAgentScenario(wrapAgentClass(HarnessAgent));
