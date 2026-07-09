const strandsAgentSDKPackageName =
  process.env.STRANDS_AGENT_SDK_PACKAGE_NAME ?? "strands-agent-sdk-v1-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedStrandsAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const strands = await import(strandsAgentSDKPackageName);
  const { OpenAIModel } = await import(
    `${strandsAgentSDKPackageName}/models/openai`
  );
  await runWrappedStrandsAgentSDKInstrumentation(strands, OpenAIModel);
});
