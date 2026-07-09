const bedrockRuntimePackageName =
  process.env.BEDROCK_RUNTIME_PACKAGE_NAME ?? "bedrock-runtime-sdk-v3-latest";
const {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} = await import(bedrockRuntimePackageName);
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoBedrockRuntimeInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoBedrockRuntimeInstrumentation({
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
    InvokeModelCommand,
    InvokeModelWithResponseStreamCommand,
    NodeHttpHandler,
  });
});
