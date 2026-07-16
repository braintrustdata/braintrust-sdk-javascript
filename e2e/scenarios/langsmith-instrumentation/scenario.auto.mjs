import { runMain } from "../../helpers/provider-runtime.mjs";
import {
  loadLangSmithNamespaces,
  runLangSmithScenario,
} from "./scenario.impl.mjs";

runMain(async () => {
  const dependencyName = process.env.LANGSMITH_PACKAGE_NAME;
  if (!dependencyName) {
    throw new Error("LANGSMITH_PACKAGE_NAME is required");
  }
  await runLangSmithScenario({
    includeLangChain: process.env.LANGSMITH_INCLUDE_LANGCHAIN === "1",
    namespaces: await loadLangSmithNamespaces(dependencyName),
    wrapped: false,
  });
});
