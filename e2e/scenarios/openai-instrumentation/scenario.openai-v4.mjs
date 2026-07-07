const openaiPackageName = process.env.OPENAI_PACKAGE_NAME ?? "openai-v4-latest";
const { default: OpenAI } = await import(openaiPackageName);
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
      openaiPackageName,
    ),
  }),
);
