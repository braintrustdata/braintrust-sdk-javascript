const strandsAgentSDKPackageName =
  process.env.STRANDS_AGENT_SDK_PACKAGE_NAME ?? "strands-agent-sdk-v1-latest";
const strands = await import(strandsAgentSDKPackageName);
const { OpenAIModel } = await import(
  `${strandsAgentSDKPackageName}/models/openai`
);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoStrandsAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(() => runAutoStrandsAgentSDKInstrumentation(strands, OpenAIModel));
