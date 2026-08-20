const packageName =
  process.env.BEDROCK_AGENT_RUNTIME_PACKAGE_NAME ??
  "bedrock-agent-runtime-sdk-v3-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedBedrockAgentRuntimeInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const {
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
    InvokeInlineAgentCommand,
    RetrieveAndGenerateCommand,
    RetrieveAndGenerateStreamCommand,
  } = await import(packageName);
  await runWrappedBedrockAgentRuntimeInstrumentation({
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
    InvokeInlineAgentCommand,
    RetrieveAndGenerateCommand,
    RetrieveAndGenerateStreamCommand,
  });
});
