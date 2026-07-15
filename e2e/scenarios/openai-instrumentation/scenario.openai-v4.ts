import { wrapOpenAI } from "braintrust";
const openaiPackageName = process.env.OPENAI_PACKAGE_NAME ?? "openai-v4-latest";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runOpenAIInstrumentationScenario } from "./scenario.impl.mjs";

runMain(async () => {
  const { default: OpenAI } = await import(openaiPackageName);
  await runOpenAIInstrumentationScenario({
    OpenAI,
    chatHelperNamespace: "beta",
    decorateClient: wrapOpenAI,
    openaiSdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      openaiPackageName,
    ),
  });
});
