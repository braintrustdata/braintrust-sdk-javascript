import { wrapAgentClass } from "braintrust";
import { runHarnessAgentScenario } from "./scenario.impl.mjs";

const harnessPackageName =
  process.env.AI_SDK_HARNESS_PACKAGE_NAME ?? "ai-sdk-harness-v1-latest";
const { HarnessAgent } = await import(`${harnessPackageName}/agent`);

await runHarnessAgentScenario(wrapAgentClass(HarnessAgent));
