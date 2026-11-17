import { getObjValueByPath } from "../../util/index";
import Mustache from "mustache";

export function lintTemplate(
  template: string,
  context: Record<string, unknown>,
): void {
  const variables = getMustacheVars(template);
  for (const variable of variables) {
    const arrPathsReplaced = variable[1].replaceAll(/\.\d+/g, ".0");
    const fieldExists =
      getObjValueByPath(context, arrPathsReplaced.split(".")) !== undefined;
    if (!fieldExists) {
      throw new Error(`Variable '${variable[1]}' does not exist.`);
    }
  }
}

function getMustacheVars(prompt: string) {
  try {
    return Mustache.parse(prompt).filter(
      (span) => span[0] === "name" || span[0] === "&",
    );
  } catch {
    return [];
  }
}
