import { wrapOpenAI } from "braintrust";
import OpenAI from "openai";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runOpenAIInstrumentationScenario } from "./scenario.impl.mjs";

runMain(async () =>
  runOpenAIInstrumentationScenario({
    OpenAI,
    chatHelperNamespace: "ga",
    decorateClient: wrapOpenAI,
    openaiSdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      "openai",
    ),
  }),
);
