import OpenAI from "openai-v4";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/provider-runtime.mjs";
import { runAutoOpenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoOpenAIInstrumentation(OpenAI, {
    chatHelperNamespace: "beta",
    openaiSdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      "openai-v4",
    ),
  }),
);
