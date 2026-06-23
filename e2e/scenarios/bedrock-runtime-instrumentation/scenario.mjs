import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
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
