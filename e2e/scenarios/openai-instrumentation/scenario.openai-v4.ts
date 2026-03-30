import { wrapOpenAI } from "braintrust";
import OpenAI from "openai-v4";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runOpenAIInstrumentationScenario } from "./scenario.impl.mjs";

runMain(async () =>
  runOpenAIInstrumentationScenario({
    OpenAI,
    chatHelperNamespace: "beta",
    decorateClient: wrapOpenAI,
    openaiSdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      "openai-v4",
    ),
  }),
);
