import { wrapOpenAI } from "braintrust";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runReasoningScenario } from "./scenario.impl.mjs";

runMain(async () => {
  const alias = process.env.OPENAI_PACKAGE_NAME!;
  const { default: OpenAI } = await import(alias);
  await runReasoningScenario({
    OpenAI,
    decorateClient: wrapOpenAI,
    openaiSdkVersion: await getInstalledPackageVersion(import.meta.url, alias),
  });
});
