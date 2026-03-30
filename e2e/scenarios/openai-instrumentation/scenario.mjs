import OpenAI from "openai";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/provider-runtime.mjs";
import { runAutoOpenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoOpenAIInstrumentation(OpenAI, {
    chatHelperNamespace: "ga",
    openaiSdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      "openai",
    ),
  }),
);
