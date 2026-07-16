import { runMain } from "../../helpers/scenario-runtime";
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
    namespaces: await loadLangSmithNamespaces(dependencyName),
    wrapped: true,
  });
});
