const packageName =
  process.env.BEDROCK_AGENT_RUNTIME_PACKAGE_NAME ??
  "bedrock-agent-runtime-sdk-v3-latest";
const {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  InvokeInlineAgentCommand,
  RetrieveAndGenerateCommand,
  RetrieveAndGenerateStreamCommand,
} = await import(packageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoBedrockAgentRuntimeInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoBedrockAgentRuntimeInstrumentation({
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
    InvokeInlineAgentCommand,
    RetrieveAndGenerateCommand,
    RetrieveAndGenerateStreamCommand,
  });
});
