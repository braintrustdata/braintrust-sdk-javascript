import {
  Function as functionSchema,
  type FunctionType as FunctionObject,
  type SavedFunctionIdType as SavedFunctionId,
  type ToolFunctionDefinitionType as ToolFunctionDefinition,
} from "../../generated_types";
import { _internalGetGlobalState } from "../../logger";
import { loadCLIEnv } from "./bundle";
import { PullArgs } from "./types";
import { warning } from "../../framework";
import { z } from "zod/v3";
import fs from "node:fs/promises";
import util from "node:util";
import { slugify } from "../../../util/string_util";
import path from "node:path";
import { currentRepo } from "../../gitutil";
import { isEmpty, loadPrettyXact, prettifyXact } from "../../../util/index";
import {
  ProjectNameIdMap,
  toolFunctionDefinitionSchema,
} from "../../framework2";
import pluralize from "pluralize";

export async function pullCommand(args: PullArgs) {
  await loadCLIEnv(args);

  const loggerConn = _internalGetGlobalState().apiConn();
  const functions = await loggerConn.get_json("/v1/function", {
    ...(args.project_id ? { project_id: args.project_id } : {}),
    ...(args.project_name ? { project_name: args.project_name } : {}),
    ...(args.slug ? { slug: args.slug } : {}),
    ...(args.id ? { ids: [args.id] } : {}),
    ...(args.version ? { version: loadPrettyXact(args.version) } : {}),
  });
  const functionObjects = z
    .object({ objects: z.array(z.unknown()) })
    .parse(functions);

  const projectNameToFunctions: Record<string, FunctionObject[]> = {};
  const projectNameIdMap = new ProjectNameIdMap();

  for (const rawFunc of functionObjects.objects) {
    const parsedFunc = functionSchema.safeParse(rawFunc);
    if (!parsedFunc.success) {
      const id =
        typeof rawFunc === "object" && rawFunc && "id" in rawFunc
          ? ` ${rawFunc.id}`
          : "";
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        warning(`Failed to parse function${id}: ${parsedFunc.error.message}`),
      );
      continue;
    }

    const func = parsedFunc.data;
    const projectName = await projectNameIdMap.getName(func.project_id);
    if (!projectNameToFunctions[projectName]) {
      projectNameToFunctions[projectName] = [];
    }
    projectNameToFunctions[projectName].push(func);
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.log("Found functions in the following projects:");
  for (const projectName of Object.keys(projectNameToFunctions)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.log(` * ${projectName}`);
  }

  const outputDir = args.output_dir ?? "./braintrust";
  await fs.mkdir(outputDir, { recursive: true });

  const git = await currentRepo();
  const diffSummary = await git?.diffSummary("HEAD");

  // Get the root directory of the Git repository
  const repoRoot = await git?.revparse(["--show-toplevel"]);

  const dirtyFiles = new Set(
    (diffSummary?.files ?? []).map((f) =>
      path.resolve(repoRoot ?? ".", f.file),
    ),
  );

  for (const projectName of Object.keys(projectNameToFunctions)) {
    const projectFile = path.join(
      outputDir,
      `${slugify(projectName, { lower: true, strict: true, trim: true })}.ts`,
    );
    const resolvedProjectFile = path.resolve(projectFile);
    const fileExists = await fs.stat(projectFile).then(
      () => true,
      () => false,
    );
    if (args.force) {
      if (fileExists) {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.warn(
          warning(
            `Overwriting ${doubleQuote(projectFile)} because --force is set.`,
          ),
        );
      }
    } else if (dirtyFiles.has(resolvedProjectFile)) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        warning(
          `Skipping project ${projectName} because ${doubleQuote(projectFile)} has uncommitted changes.`,
        ),
      );
      continue;
    } else if (fileExists) {
      if (!git) {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.warn(
          warning(
            `Project ${projectName} already exists in ${doubleQuote(projectFile)}. Skipping since this is not a git repository...`,
          ),
        );
        continue;
      } else {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.warn(
          warning(
            `Project ${projectName} already exists in ${doubleQuote(projectFile)}. Overwriting...`,
          ),
        );
      }
    }

    const projectFileContents = await makeProjectFile({
      projectName,
      projectId: await projectNameIdMap.getId(projectName),
      fileName: projectFile,
      functions: projectNameToFunctions[projectName],
      hasSpecifiedFunction: !!args.slug || !!args.id,
    });
    await fs.writeFile(projectFile, projectFileContents || "");
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.log(`Wrote ${projectName} to ${doubleQuote(projectFile)}`);
  }
}

async function makeProjectFile({
  projectName,
  projectId,
  fileName,
  functions,
  hasSpecifiedFunction,
}: {
  projectName: string;
  projectId: string;
  fileName: string;
  functions: FunctionObject[];
  hasSpecifiedFunction: boolean;
}) {
  const varNames = {};
  const functionDefinitions = functions
    .map((f) =>
      makeFunctionDefinition({ func: f, varNames, hasSpecifiedFunction }),
    )
    .filter((f) => f !== null);
  const fileDef = `// This file was automatically generated by braintrust pull. You can
// generate it again by running:
//  $ braintrust pull --project-name ${doubleQuote(projectName)}
// Feel free to edit this file manually, but once you do, you should make sure to
// sync your changes with Braintrust by running:
//  $ braintrust push ${doubleQuote(fileName)}

import braintrust from "braintrust";

const project = braintrust.projects.create({
  id: ${doubleQuote(projectId)},
  name: ${doubleQuote(projectName)},
});

${functionDefinitions.join("\n")}
`;

  const prettier = await getPrettierModule();
  if (prettier) {
    try {
      const formatted = prettier.format(fileDef, {
        parser: "typescript",
      });
      return formatted;
    } catch (error) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        warning(
          `Failed to format with prettier (${error instanceof Error ? error.message : error}). Using unformatted output.`,
        ),
      );
    }
  }
  return fileDef;
}

function makeFunctionDefinition({
  func,
  varNames,
  hasSpecifiedFunction,
}: {
  func: FunctionObject;
  varNames: Record<string, string>;
  hasSpecifiedFunction: boolean;
}): string | null {
  if (func.function_data.type !== "prompt") {
    if (hasSpecifiedFunction) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(
        warning(
          `Skipping function ${doubleQuote(func.name)} because it is not a prompt.`,
        ),
      );
    }
    return null;
  }

  const baseVarName = slugToVarName(func.slug);
  let varName = baseVarName;
  let suffix = 1;
  while (varName in varNames) {
    varName = `${varName}${suffix}`;
    suffix++;
  }
  varNames[varName] = func.slug;

  if (!func.prompt_data || !func.prompt_data.prompt) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(
      warning(
        `Prompt ${doubleQuote(func.name)} has an invalid (empty) prompt definition.`,
      ),
    );
    return null;
  }
  const objectType = "prompt";
  const prompt = func.prompt_data.prompt;
  const promptContents =
    prompt.type === "completion"
      ? `prompt: ${doubleQuote(prompt.content)}`
      : `messages: ${safeStringify(prompt.messages).trimStart()}`;

  const rawToolsParsed =
    prompt.type === "chat" && prompt.tools && prompt.tools.length > 0
      ? z
          .array(toolFunctionDefinitionSchema)
          .safeParse(JSON.parse(prompt.tools))
      : undefined;

  if (rawToolsParsed && !rawToolsParsed.success) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(
      warning(
        `Prompt ${doubleQuote(func.name)} has an invalid tools definition: ${rawToolsParsed.error.message}. Skipping...`,
      ),
    );
    return null;
  }

  const rawTools = rawToolsParsed ? rawToolsParsed.data : [];

  const { model, params } = func.prompt_data.options ?? {};

  const paramsString =
    params && Object.keys(params).length > 0
      ? `params: ${safeStringify(params).trimStart()},`
      : "";

  const tools: (SavedFunctionId | ToolFunctionDefinition)[] = [
    ...(func.prompt_data.tool_functions ?? []),
    ...rawTools,
  ];

  const toolsString =
    tools.length > 0 ? `tools: ${safeStringify(tools).trimStart()},` : "";

  return `export const ${varName} = project.${pluralize(objectType)}.create({
  id: ${doubleQuote(func.id)},
  name: ${doubleQuote(func.name)},
  slug: ${doubleQuote(func.slug)},
  version: ${doubleQuote(prettifyXact(func._xact_id))}, ${printOptionalField("description", func.description)}${printOptionalField("model", model)}
${indent(promptContents, 2)},
${indent(paramsString, 2)}
${indent(toolsString, 2)}
});
`;
}

function doubleQuote(str: string) {
  return JSON.stringify(str);
}

function slugToVarName(slug: string) {
  let varName = slug.replace(/^[^a-zA-Z_$]|[^a-zA-Z0-9_$]/g, "_");
  varName = varName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  varName = varName.charAt(0).toLowerCase() + varName.slice(1);
  return varName;
}

function indent(str: string, numSpaces: number) {
  return str.replace(/^/gm, " ".repeat(numSpaces));
}

function printOptionalField(
  fieldName: string,
  fieldValue: string | undefined | null,
) {
  return !isEmpty(fieldValue)
    ? `
  ${fieldName}: ${doubleQuote(fieldValue)},`
    : "";
}

let prettierImportAttempted = false;

let prettierModule: typeof import("prettier") | undefined = undefined;

async function getPrettierModule() {
  if (!prettierModule && !prettierImportAttempted) {
    prettierImportAttempted = true;

    try {
      // First try require() which is more stable in npx environments
      prettierModule = require("prettier");
    } catch {
      try {
        // Fallback to dynamic import with error boundary
        const importWithTimeout = () => {
          return new Promise<typeof import("prettier")>((resolve, reject) => {
            let resolved = false;

            // Set a timeout to prevent infinite hanging
            const timeoutId = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                reject(new Error("Prettier import timeout"));
              }
            }, 3000);

            import("prettier")
              .then((module) => {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeoutId);
                  resolve(module);
                }
              })
              .catch((error) => {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeoutId);
                  reject(error);
                }
              });
          });
        };

        prettierModule = await importWithTimeout();
      } catch {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.warn(
          warning(
            "Failed to load prettier module. Will not use prettier to format output.",
          ),
        );
        prettierModule = undefined;
      }
    }
  }
  return prettierModule;
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (error) {
    // Fallback for circular references or other JSON.stringify issues
    try {
      return util.inspect(obj, {
        depth: 5,
        maxStringLength: 1000,
        breakLength: 80,
        compact: false,
      });
    } catch {
      return `[Object: Unable to serialize - ${error instanceof Error ? error.message : error}]`;
    }
  }
}
