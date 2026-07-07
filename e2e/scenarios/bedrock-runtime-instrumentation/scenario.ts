const bedrockRuntimePackageName =
  process.env.BEDROCK_RUNTIME_PACKAGE_NAME ?? "bedrock-runtime-sdk-v3-latest";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedBedrockRuntimeInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const {
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
    InvokeModelCommand,
    InvokeModelWithResponseStreamCommand,
  } = await import(bedrockRuntimePackageName);
  await runWrappedBedrockRuntimeInstrumentation({
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
    InvokeModelCommand,
    InvokeModelWithResponseStreamCommand,
    NodeHttpHandler,
  });
});
