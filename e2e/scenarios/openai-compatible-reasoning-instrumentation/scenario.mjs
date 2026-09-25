import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/provider-runtime.mjs";
import { runReasoningScenario } from "./scenario.impl.mjs";

runMain(async () => {
  const alias = process.env.OPENAI_PACKAGE_NAME;
  const { default: OpenAI } = await import(alias);
  await runReasoningScenario({
    OpenAI,
    openaiSdkVersion: await getInstalledPackageVersion(import.meta.url, alias),
  });
});
