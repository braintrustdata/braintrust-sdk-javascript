#!/usr/bin/env node

import * as esbuild from "esbuild";
import * as dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import * as fsWalk from "@nodelib/fs.walk";
import { minimatch } from "minimatch";
import { ArgumentParser } from "argparse";
import { v4 as uuidv4 } from "uuid";
import pluralize from "pluralize";
import {
  login,
  init as _initExperiment,
  Experiment,
  BaseMetadata,
  Dataset,
} from "../logger";
import type { ProgressReporter } from "../reporters/types";
import {
  BarProgressReporter,
  SimpleProgressReporter,
} from "./reporters/progress";
import chalk from "chalk";
import { terminalLink } from "termi-link";

// Re-use the module resolution logic from Jest
import type { ReporterDef } from "../reporters/types";
import {
  EvalData,
  EvaluatorDef,
  EvaluatorFile,
  Filter,
  callEvaluatorData,
  error,
  logError,
  parseFilters,
  runEvaluator,
} from "../framework";
import { fancyReporter, warning } from "./reporters/eval";
import { configureNode } from "../node/config";
import { isEmpty } from "../util";
import { loadEnvConfig } from "@next/env";
import type {
  BuildSuccess,
  BuildFailure,
  BtBuildResult,
  FileHandle,
  EvaluatorState,
} from "./types";
import { uploadHandleBundles } from "./functions/upload";
import { loadModule } from "./functions/load-module";
import { bundleCommand } from "./util/bundle";
import { RunArgs } from "./util/types";
import { pullCommand } from "./util/pull";
import { runDevServer } from "../../dev/server";

// This requires require
// https://stackoverflow.com/questions/50822310/how-to-import-package-json-in-typescript
const { version } = require("../../package.json");

// TODO: This could be loaded from configuration
const INCLUDE_EVAL = [
  "**/*.eval.ts",
  "**/*.eval.tsx",
  "**/*.eval.js",
  "**/*.eval.jsx",
];
const INCLUDE_BUNDLE = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/build/**"];
const OUT_EXT = "js";

configureNode();

// Resolve tsconfig extends that point to node_modules packages
// esbuild doesn't resolve package-style extends like TypeScript does
function resolveTsconfigExtends(tsconfigPath: string): string | undefined {
  try {
    const tsconfigContent = fs.readFileSync(tsconfigPath, "utf-8");
    // Strip comments and trailing commas for JSON.parse (simple regex, not perfect)
    const cleanedContent = tsconfigContent
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const tsconfig = JSON.parse(cleanedContent);

    if (!tsconfig.extends) {
      return tsconfigPath;
    }

    const extendsPath = tsconfig.extends;

    // If it's already a relative path or absolute path, no resolution needed
    if (extendsPath.startsWith(".") || extendsPath.startsWith("/")) {
      return tsconfigPath;
    }

    // Try to resolve the extends path from node_modules
    const tsconfigDir = path.dirname(tsconfigPath);
    let resolvedExtendsPath: string;
    try {
      // Try to resolve as a package
      resolvedExtendsPath = require.resolve(extendsPath, {
        paths: [tsconfigDir],
      });
    } catch {
      // If that fails, try adding .json extension
      try {
        resolvedExtendsPath = require.resolve(`${extendsPath}.json`, {
          paths: [tsconfigDir],
        });
      } catch {
        // Can't resolve - just return original and let esbuild handle the error
        return tsconfigPath;
      }
    }

    // Create a temporary tsconfig with the resolved extends path
    const tmpDir = path.join(
      os.tmpdir(),
      `bt-tsconfig-${uuidv4().slice(0, 8)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpTsconfigPath = path.join(tmpDir, "tsconfig.json");

    // Make the extends path relative to the temp directory
    const relativeExtendsPath = path.relative(tmpDir, resolvedExtendsPath);
    tsconfig.extends = relativeExtendsPath;

    // Also need to resolve any relative paths in the original tsconfig
    // to be relative to the temp directory
    if (tsconfig.compilerOptions?.baseUrl) {
      const resolvedBaseUrl = path.resolve(
        tsconfigDir,
        tsconfig.compilerOptions.baseUrl,
      );
      tsconfig.compilerOptions.baseUrl = path.relative(tmpDir, resolvedBaseUrl);
    }

    // Include/exclude paths should be relative to the original tsconfig
    if (tsconfig.include) {
      tsconfig.include = tsconfig.include.map((p: string) =>
        path.resolve(tsconfigDir, p),
      );
    }
    if (tsconfig.exclude) {
      tsconfig.exclude = tsconfig.exclude.map((p: string) =>
        path.resolve(tsconfigDir, p),
      );
    }
    if (tsconfig.files) {
      tsconfig.files = tsconfig.files.map((p: string) =>
        path.resolve(tsconfigDir, p),
      );
    }

    fs.writeFileSync(tmpTsconfigPath, JSON.stringify(tsconfig, null, 2));
    return tmpTsconfigPath;
  } catch {
    // If anything goes wrong, return original path
    return tsconfigPath;
  }
}

function evaluateBuildResults(
  inFile: string,
  buildResult: esbuild.BuildResult,
): EvaluatorFile | null {
  if (!buildResult.outputFiles) {
    return null;
  }
  const moduleText = buildResult.outputFiles[0].text;
  return loadModule({ inFile, moduleText });
}

async function initExperiment(
  evaluator: EvaluatorDef<unknown, unknown, unknown, BaseMetadata>,
  evaluatorData: {
    data: EvalData<unknown, unknown, BaseMetadata>;
    baseExperiment: string | undefined;
  },
) {
  const { data, baseExperiment: defaultBaseExperiment } = evaluatorData;
  // NOTE: This code is duplicated with initExperiment in js/src/framework.ts.
  // Make sure to update that if you change this.
  const logger = _initExperiment({
    state: evaluator.state,
    ...(evaluator.projectId
      ? { projectId: evaluator.projectId }
      : { project: evaluator.projectName }),
    experiment: evaluator.experimentName,
    description: evaluator.description,
    metadata: evaluator.metadata,
    tags: evaluator.tags,
    isPublic: evaluator.isPublic,
    update: evaluator.update,
    baseExperiment: evaluator.baseExperimentName ?? defaultBaseExperiment,
    baseExperimentId: evaluator.baseExperimentId,
    gitMetadataSettings: evaluator.gitMetadataSettings,
    repoInfo: evaluator.repoInfo,
    dataset: Dataset.isDataset(data) ? data : undefined,
    setCurrent: false,
  });
  const info = await logger.summarize({ summarizeScores: false });
  const linkText = info.experimentUrl
    ? terminalLink(info.experimentUrl, info.experimentUrl, {
        fallback: (_text: string, url: string) => url,
      })
    : "locally";
  console.error(
    chalk.cyan("▶") +
      ` Experiment ${chalk.bold(info.experimentName)} is running at ${linkText}`,
  );
  return logger;
}

function resolveReporter(
  reporter: string | ReporterDef<unknown> | undefined,
  reporters: Record<string, ReporterDef<unknown>>,
) {
  if (typeof reporter === "string") {
    if (!reporters[reporter]) {
      throw new Error(`Reporter ${reporter} not found`);
    }
    return reporters[reporter];
  } else if (!isEmpty(reporter)) {
    return reporter;
  } else if (Object.keys(reporters).length === 0) {
    return fancyReporter;
  } else if (Object.keys(reporters).length === 1) {
    return reporters[Object.keys(reporters)[0]];
  } else {
    const reporterNames = Object.keys(reporters).join(", ");
    throw new Error(
      `Multiple reporters found (${reporterNames}). Please specify a reporter explicitly.`,
    );
  }
}

type AllReports = Record<
  string,
  {
    reporter: ReporterDef<unknown>;
    results: (unknown | Promise<unknown>)[];
  }
>;

function addReport(
  evalReports: AllReports,
  reporter: ReporterDef<unknown>,
  report: unknown,
) {
  if (!evalReports[reporter.name]) {
    evalReports[reporter.name] = {
      reporter,
      results: [],
    };
  }
  evalReports[reporter.name].results.push(report);
}

function buildWatchPluginForEvaluator(
  inFile: string,
  opts: EvaluatorOpts,
): esbuild.Plugin {
  const evaluators: EvaluatorState = {
    evaluators: [],
    reporters: {},
  };
  const plugin = {
    name: "run-evalutator-on-end",
    setup(build: esbuild.PluginBuild) {
      build.onEnd(async (result) => {
        console.error(`Done building ${inFile}`);

        if (!result.outputFiles) {
          if (opts.verbose) {
            console.warn(`Failed to compile ${inFile}`);
            console.warn(result.errors);
          } else {
            console.warn(`Failed to compile ${inFile}: ${result.errors}`);
          }
          return;
        }

        const evalResult = evaluateBuildResults(inFile, result);
        if (!evalResult) {
          return;
        }

        evaluators.evaluators = evaluators.evaluators.filter(
          (e) => e.sourceFile !== inFile,
        );

        // Update the evaluators and reporters
        for (const evaluator of Object.values(evalResult.evaluators)) {
          evaluators.evaluators.push({
            sourceFile: inFile,
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            evaluator: evaluator.evaluator as EvaluatorDef<
              unknown,
              unknown,
              unknown,
              BaseMetadata
            >,
            reporter: evaluator.reporter,
          });
        }
        for (const [reporterName, reporter] of Object.entries(
          evalResult.reporters,
        )) {
          evaluators.reporters[reporterName] = reporter;
        }

        const evalReports: Record<
          string,
          {
            reporter: ReporterDef<unknown>;
            results: unknown[];
          }
        > = {};
        for (const evaluatorDef of Object.values(evalResult.evaluators)) {
          const { evaluator, reporter } = evaluatorDef;
          const evalData = callEvaluatorData(evaluator.data);
          const logger = opts.noSendLogs
            ? null
            : await initExperiment(evaluator, evalData);
          const evaluatorResult = await runEvaluator(
            logger,
            {
              ...evaluator,
              data: evalData.data,
            },
            opts.progressReporter,
            opts.filters,
            undefined,
            undefined,
          );
          const resolvedReporter = resolveReporter(
            reporter,
            evaluators.reporters, // Let these accumulate across all files.
          );

          const report = resolvedReporter.reportEval(
            evaluator,
            evaluatorResult,
            {
              verbose: opts.verbose,
              jsonl: opts.jsonl,
            },
          );

          addReport(evalReports, resolvedReporter, report);
        }

        for (const [reporterName, { reporter, results }] of Object.entries(
          evalReports,
        )) {
          const success = await reporter.reportRun(await Promise.all(results));
          if (!success) {
            console.error(error(`Reporter ${reporterName} failed.`));
          }
        }
      });
    },
  };

  return plugin;
}

async function initFile({
  inFile,
  outFile,
  bundleFile,
  tsconfig,
  plugins,
  externalPackages,
}: {
  inFile: string;
  outFile: string;
  bundleFile: string;
  tsconfig?: string;
  plugins?: PluginMaker[];
  externalPackages?: string[];
}): Promise<FileHandle> {
  const buildOptions = buildOpts({
    fileName: inFile,
    outFile,
    tsconfig,
    plugins,
    externalPackages,
  });
  const ctx = await esbuild.context(buildOptions);

  return {
    inFile,
    outFile,
    bundleFile,
    rebuild: async () => {
      try {
        const result = await ctx.rebuild();
        if (!result.outputFiles) {
          return {
            type: "failure",
            error: new Error("No output file generated"),
            sourceFile: inFile,
          };
        }
        const evaluator = evaluateBuildResults(inFile, result) || {
          functions: [],
          prompts: [],
          parameters: [],
          evaluators: {},
          reporters: {},
        };
        return { type: "success", result, evaluator, sourceFile: inFile };
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return { type: "failure", error: e as Error, sourceFile: inFile };
      }
    },
    bundle: async () => {
      const buildOptions: esbuild.BuildOptions = {
        ...buildOpts({
          fileName: inFile,
          outFile: bundleFile,
          tsconfig,
          plugins,
          externalPackages,
        }),
        external: ["fsevents", "chokidar"],
        write: true,
        plugins: [],
        minify: true,
        sourcemap: true,
      };
      return await esbuild.build(buildOptions);
    },
    watch: () => {
      ctx.watch();
    },
    destroy: async () => {
      await ctx.dispose();
    },
  };
}

interface EvaluatorOpts {
  verbose: boolean;
  apiKey?: string;
  orgName?: string;
  appUrl?: string;
  noSendLogs: boolean;
  bundle: boolean;
  setCurrent: boolean;
  terminateOnFailure: boolean;
  watch: boolean;
  list: boolean;
  jsonl: boolean;
  filters: Filter[];
  progressReporter: ProgressReporter;
}

export function handleBuildFailure({
  result,
  terminateOnFailure,
  verbose,
}: {
  result: BuildFailure;
  terminateOnFailure: boolean;
  verbose: boolean;
}) {
  if (terminateOnFailure) {
    throw result.error;
  } else if (verbose) {
    console.warn(`Failed to compile ${result.sourceFile}`);
    console.warn(result.error);
  } else {
    console.warn(
      `Failed to compile ${result.sourceFile}: ${result.error.message}`,
    );
  }
}

function updateEvaluators(
  evaluators: EvaluatorState,
  buildResults: BtBuildResult[],
  opts: EvaluatorOpts,
) {
  for (const result of buildResults) {
    if (result.type === "failure") {
      handleBuildFailure({
        result,
        terminateOnFailure: opts.terminateOnFailure,
        verbose: opts.verbose,
      });
      continue;
    }

    for (const evaluator of Object.values(result.evaluator.evaluators)) {
      evaluators.evaluators.push({
        sourceFile: result.sourceFile,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        evaluator: evaluator.evaluator as EvaluatorDef<
          unknown,
          unknown,
          unknown,
          BaseMetadata
        >,
        reporter: evaluator.reporter,
      });
    }

    for (const [reporterName, reporter] of Object.entries(
      result.evaluator.reporters,
    )) {
      if (
        evaluators.reporters[reporterName] &&
        evaluators.reporters[reporterName] !== reporter
      ) {
        console.warn(
          warning(
            `Reporter '${reporterName}' already exists. Will skip '${reporterName}' from ${result.sourceFile}.`,
          ),
        );
        continue;
      }
      evaluators.reporters[reporterName] = reporter;
    }
  }
}

async function runAndWatch({
  handles,
  onExit,
}: {
  handles: Record<string, FileHandle>;
  onExit?: () => void;
}) {
  const count = Object.keys(handles).length;
  console.error(`Watching ${pluralize("file", count, true)}...`);

  Object.values(handles).map((handle) => handle.watch());

  ["SIGINT", "SIGTERM"].forEach((signal: string) => {
    process.on(signal, function () {
      console.error("Stopped watching.");
      for (const handle of Object.values(handles)) {
        handle.destroy();
      }
      onExit?.();
      process.exit(0);
    });
  });

  // Wait forever while we watch.
  await new Promise(() => {});
}

export async function buildEvaluators(
  handles: Record<string, FileHandle>,
  opts: EvaluatorOpts,
): Promise<{ evaluators: EvaluatorState; buildResults: BtBuildResult[] }> {
  const buildPromises = Object.values(handles).map((handle) =>
    handle.rebuild(),
  );

  const buildResults = await Promise.all(buildPromises);

  const evaluators: EvaluatorState = {
    evaluators: [],
    reporters: {},
  };
  updateEvaluators(evaluators, buildResults, opts);
  return { evaluators, buildResults };
}

async function runOnce(
  handles: Record<string, FileHandle>,
  opts: EvaluatorOpts,
) {
  const bundlePromises = opts.bundle
    ? Object.fromEntries(
        Object.entries(handles).map(([inFile, handle]) => [
          inFile,
          handle.bundle(),
        ]),
      )
    : null;

  const { evaluators, buildResults } = await buildEvaluators(handles, opts);

  if (opts.list) {
    for (const evaluator of evaluators.evaluators) {
      console.log(evaluator.evaluator.evalName);
    }
    return true;
  }

  // map from file name -> eval name -> experiment
  const evalToExperiment: Record<string, Record<string, Experiment>> = {};

  const resultPromises = evaluators.evaluators.map(async (evaluator) => {
    const evalData = callEvaluatorData(evaluator.evaluator.data);
    // TODO: For now, use the eval name as the project. However, we need to evolve
    // the definition of a project and create a new concept called run, so that we
    // can name the experiment/evaluation within the run the evaluator's name.
    const logger = opts.noSendLogs
      ? null
      : await initExperiment(evaluator.evaluator, evalData);
    try {
      return await runEvaluator(
        logger,
        {
          ...evaluator.evaluator,
          data: evalData.data,
        },
        opts.progressReporter,
        opts.filters,
        undefined,
        undefined,
      );
    } finally {
      if (logger) {
        if (!evalToExperiment[evaluator.sourceFile]) {
          evalToExperiment[evaluator.sourceFile] = {};
        }
        evalToExperiment[evaluator.sourceFile][evaluator.evaluator.evalName] =
          logger;

        await logger.flush();
      }
    }
  });

  console.error(
    chalk.dim(
      `Processing ${chalk.bold(resultPromises.length)} evaluator${resultPromises.length === 1 ? "" : "s"}...`,
    ),
  );
  const allEvalsResults = await Promise.all(resultPromises);
  opts.progressReporter.stop();
  console.error("");

  const evalReports: Record<
    string,
    {
      reporter: ReporterDef<unknown>;
      results: unknown[];
    }
  > = {};
  for (let idx = 0; idx < evaluators.evaluators.length; idx++) {
    const evaluator = evaluators.evaluators[idx];
    const resolvedReporter = resolveReporter(
      evaluator.reporter,
      evaluators.reporters,
    );

    const report = resolvedReporter.reportEval(
      evaluator.evaluator,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      allEvalsResults[idx as number],
      {
        verbose: opts.verbose,
        jsonl: opts.jsonl,
      },
    );

    addReport(evalReports, resolvedReporter, report);
  }

  if (bundlePromises !== null && Object.entries(evalToExperiment).length > 0) {
    await uploadHandleBundles({
      buildResults: buildResults.filter(
        // We handle errors above, so it's fine to filter down to successes here.
        (result): result is BuildSuccess => result.type === "success",
      ),
      evalToExperiment,
      bundlePromises,
      handles,
      setCurrent: opts.setCurrent,
      defaultIfExists: "replace",
      verbose: opts.verbose,
    });
  }

  let allSuccess = true;
  for (const [_reporterName, { reporter, results }] of Object.entries(
    evalReports,
  )) {
    const success = await reporter.reportRun(await Promise.all(results));
    allSuccess = allSuccess && success;
  }

  return allSuccess;
}

function checkMatch(
  pathInput: string,
  include_patterns: string[] | null,
  exclude_patterns: string[] | null,
): boolean {
  const p = path.resolve(pathInput);
  if (include_patterns !== null) {
    let include = false;
    for (const pattern of include_patterns) {
      if (minimatch(p, pattern)) {
        include = true;
        break;
      }
    }
    if (!include) {
      return false;
    }
  }

  if (exclude_patterns !== null) {
    let exclude = false;
    for (const pattern of exclude_patterns) {
      if (minimatch(p, pattern)) {
        exclude = true;
        break;
      }
    }

    return !exclude;
  }

  return true;
}

async function collectFiles(
  inputPath: string,
  mode: "eval" | "bundle",
): Promise<string[]> {
  let pathStat = null;
  try {
    pathStat = fs.lstatSync(inputPath);
  } catch (e) {
    console.error(error(`Error reading ${inputPath}: ${e}`));
    process.exit(1);
  }

  let files: string[] = [];
  if (!pathStat.isDirectory()) {
    if (
      !checkMatch(
        inputPath,
        mode === "eval" ? INCLUDE_EVAL : INCLUDE_BUNDLE,
        EXCLUDE,
      )
    ) {
      const prefix = mode === "eval" ? ".eval" : "";
      console.warn(
        warning(
          `Reading ${inputPath} because it was specified directly. Rename it to end in ${prefix}.ts or ` +
            `.${prefix}.js to include it automatically when you specify a directory.`,
        ),
      );
    }
    files.push(inputPath);
  } else {
    const walked = await util.promisify(fsWalk.walk)(inputPath, {
      deepFilter: (entry) => {
        return checkMatch(entry.path, null, EXCLUDE);
      },
      entryFilter: (entry) => {
        return (
          entry.dirent.isFile() &&
          checkMatch(
            entry.path,
            mode === "eval" ? INCLUDE_EVAL : INCLUDE_BUNDLE,
            EXCLUDE,
          )
        );
      },
    });

    files = files.concat(walked.map((entry) => entry.path));
  }

  return files;
}

import { createMarkKnownPackagesExternalPlugin } from "./util/external-packages-plugin";

// Inspired by and modified from https://github.com/evanw/esbuild/issues/1051
const nativeNodeModulesPlugin = {
  name: "native-node-modules",
  setup(build: esbuild.PluginBuild) {
    // Keep track of packages that contain .node or .wasm files
    const nativePackages = new Set<string>();
    // Track packages we've already checked for wasm files
    const checkedPackages = new Set<string>();

    // Helper to add a package and its platform-specific variants
    const addNativePackage = (pkgName: string) => {
      nativePackages.add(pkgName);
      if (pkgName.includes("@")) {
        const [scope, name] = pkgName.split("/");
        const platformPkgs = [
          `${scope}/${name}-darwin-arm64`,
          `${scope}/${name}-darwin-x64`,
          `${scope}/${name}-linux-x64-gnu`,
          `${scope}/${name}-win32-x64-msvc`,
        ];
        platformPkgs.forEach((pkg) => nativePackages.add(pkg));
      }
    };

    // Check if a package directory contains wasm files
    const packageContainsWasm = (pkgPath: string): boolean => {
      try {
        const checkDir = (dir: string, depth = 0): boolean => {
          if (depth > 2) return false; // Limit recursion depth
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".wasm")) {
              return true;
            }
            if (
              entry.isDirectory() &&
              !entry.name.startsWith(".") &&
              entry.name !== "node_modules"
            ) {
              if (checkDir(path.join(dir, entry.name), depth + 1)) {
                return true;
              }
            }
          }
          return false;
        };
        return checkDir(pkgPath);
      } catch {
        return false;
      }
    };

    // When a .node file is imported, mark its package as native
    build.onResolve({ filter: /\.node$/ }, (args) => {
      try {
        const resolvedPath = require.resolve(args.path, {
          paths: [args.resolveDir],
        });
        const match = resolvedPath.match(
          /node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/,
        );
        if (match) {
          addNativePackage(match[1]);
        }
      } catch {
        // Ignore errors
      }
      return { path: args.path, external: true };
    });

    // When a .wasm file is imported, mark its package as native
    // This ensures packages like libpg-query can find their .wasm files at runtime
    build.onResolve({ filter: /\.wasm$/ }, (args) => {
      try {
        const resolvedPath = require.resolve(args.path, {
          paths: [args.resolveDir],
        });
        const match = resolvedPath.match(
          /node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/,
        );
        if (match) {
          addNativePackage(match[1]);
        }
      } catch {
        // Ignore errors
      }
      return { path: args.path, external: true };
    });

    // Handle direct imports of native packages
    build.onResolve(
      { filter: /@[^/]+\/[^/]+-(?:darwin|linux|win32)/ },
      (args) => {
        const match = args.path.match(/^(@[^/]+\/[^/]+)/);
        if (match) {
          addNativePackage(match[1]);
        }
        return { path: args.path, external: true };
      },
    );

    // Mark all imports from native packages as external
    // Also check if packages contain wasm files and mark them external
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
        const match = args.path.match(/^(?:@[^/]+\/)?[^/]+/);
        if (match) {
          const pkgName = match[0];

          // Check if already marked as native
          if (nativePackages.has(pkgName)) {
            return { path: require.resolve(args.path), external: true };
          }

          // Check if this package contains wasm files (only check once per package)
          if (!checkedPackages.has(pkgName)) {
            checkedPackages.add(pkgName);
            try {
              const pkgJsonPath = require.resolve(`${pkgName}/package.json`, {
                paths: [args.resolveDir],
              });
              const pkgDir = path.dirname(pkgJsonPath);
              if (packageContainsWasm(pkgDir)) {
                addNativePackage(pkgName);
                return { path: require.resolve(args.path), external: true };
              }
            } catch {
              // Ignore errors - package might not have package.json accessible
            }
          }
        }
      }
      return null;
    });
  },
};

export type PluginMaker = (fileName: string) => esbuild.Plugin;

function buildOpts({
  fileName,
  outFile,
  tsconfig,
  plugins: argPlugins,
  externalPackages,
}: {
  fileName: string;
  outFile: string;
  tsconfig?: string;
  plugins?: PluginMaker[];
  externalPackages?: string[];
}): esbuild.BuildOptions {
  const plugins = [
    nativeNodeModulesPlugin,
    createMarkKnownPackagesExternalPlugin(externalPackages),
    ...(argPlugins || []).map((fn) => fn(fileName)),
  ];

  // Resolve tsconfig extends that point to node_modules packages
  const resolvedTsconfig = tsconfig
    ? resolveTsconfigExtends(path.resolve(tsconfig))
    : undefined;

  return {
    entryPoints: [fileName],
    bundle: true,
    treeShaking: true,
    outfile: outFile,
    platform: "node",
    write: false,
    // Remove the leading "v" from process.version
    target: `node${process.version.slice(1)}`,
    tsconfig: resolvedTsconfig,
    external: ["node_modules/*", "fsevents"],
    plugins: plugins,
  };
}

export async function initializeHandles({
  files: inputFiles,
  mode,
  plugins,
  tsconfig,
  externalPackages,
}: {
  files: string[];
  mode: "eval" | "bundle";
  plugins?: PluginMaker[];
  tsconfig?: string;
  externalPackages?: string[];
}): Promise<Record<string, FileHandle>> {
  const files: Record<string, boolean> = {};
  const inputPaths = inputFiles.length > 0 ? inputFiles : ["."];
  for (const inputPath of inputPaths) {
    const newFiles = await collectFiles(inputPath, mode);
    if (newFiles.length == 0) {
      console.warn(
        warning(
          `Provided path ${inputPath} is not an eval file or a directory containing eval files, skipping...`,
        ),
      );
    }
    for (const file of newFiles) {
      files[path.resolve(file)] = true;
    }
  }

  if (Object.keys(files).length == 0) {
    console.warn(
      warning("No eval files were found in any of the provided paths."),
    );
    process.exit(0);
  }

  const tmpDir = path.join(os.tmpdir(), `btevals-${uuidv4().slice(0, 8)}`);
  // fs.mkdirSync(tmpDir, { recursive: true });

  const initPromises = [];
  for (const file of Object.keys(files)) {
    const baseName = `${path.basename(
      file,
      path.extname(file),
    )}-${uuidv4().slice(0, 8)}`;
    const outFile = path.join(tmpDir, `${baseName}.${OUT_EXT}`);
    const bundleFile = path.join(tmpDir, `${baseName}.bundle.js`);
    initPromises.push(
      initFile({
        inFile: file,
        outFile,
        bundleFile,
        plugins,
        tsconfig,
        externalPackages,
      }),
    );
  }

  const handles: Record<string, FileHandle> = {};
  const initResults = await Promise.all(initPromises);
  for (const result of initResults) {
    handles[result.inFile] = result;
  }
  return handles;
}

async function run(args: RunArgs) {
  // Load the environment variables from the .env files using the same rules as Next.js
  loadEnvConfig(process.cwd(), true);

  if (args.env_file) {
    // Load via dotenv library
    const loaded = dotenv.config({ path: args.env_file });
    if (loaded.error) {
      console.error(error(`Error loading ${args.env_file}: ${loaded.error}`));
      process.exit(1);
    }
  }

  const evaluatorOpts: EvaluatorOpts = {
    verbose: args.verbose,
    apiKey: args.api_key,
    orgName: args.org_name,
    appUrl: args.app_url,
    noSendLogs: !!args.no_send_logs,
    bundle: !!args.bundle || !!args.push,
    setCurrent: !!args.push,
    terminateOnFailure: !!args.terminate_on_failure,
    watch: !!args.watch,
    jsonl: args.jsonl,
    progressReporter: args.no_progress_bars
      ? new SimpleProgressReporter()
      : new BarProgressReporter(),
    filters: args.filter ? parseFilters(args.filter) : [],
    list: !!args.list,
  };

  if (args.list && args.watch) {
    console.error(error("Cannot specify both --list and --watch."));
    process.exit(1);
  }

  const plugins = evaluatorOpts.watch
    ? [
        (fileName: string) =>
          buildWatchPluginForEvaluator(fileName, evaluatorOpts),
      ]
    : [];

  const handles = await initializeHandles({
    files: args.files,
    mode: "eval",
    tsconfig: args.tsconfig,
    plugins,
    externalPackages: args.external_packages,
  });

  if (args.dev) {
    // XXX We should watch these files (or support a --watch flag).
    const { evaluators } = await buildEvaluators(handles, evaluatorOpts);
    const allEvaluators = Object.values(evaluators.evaluators).map(
      (e) => e.evaluator,
    );
    runDevServer(allEvaluators, {
      host: args.dev_host,
      port: args.dev_port,
      orgName: args.dev_org_name,
    });
    return;
  }

  let success = true;
  try {
    if (!evaluatorOpts.noSendLogs) {
      await login({
        apiKey: args.api_key,
        orgName: args.org_name,
        appUrl: args.app_url,
      });
    }

    if (args.watch) {
      await runAndWatch({
        handles,
        onExit: () => {
          evaluatorOpts.progressReporter.stop();
        },
      });
    } else {
      success = await runOnce(handles, evaluatorOpts);
    }
  } finally {
    // ESBuild can freeze up if you do not clean up the handles properly
    for (const handle of Object.values(handles)) {
      await handle.destroy();
    }
  }

  if (!success) {
    process.exit(1);
  }
}

function addAuthArgs(parser: ArgumentParser) {
  parser.add_argument("--api-key", {
    help: "Specify a braintrust api key. If the parameter is not specified, the BRAINTRUST_API_KEY environment variable will be used.",
  });
  parser.add_argument("--org-name", {
    help: "The name of a specific organization to connect to. This is useful if you belong to multiple.",
  });
  parser.add_argument("--app-url", {
    help: "Specify a custom braintrust app url. Defaults to https://www.braintrust.dev. This is only necessary if you are using an experimental version of Braintrust",
  });
  parser.add_argument("--env-file", {
    help: "A path to a .env file containing environment variables to load (via dotenv).",
  });
}

function addCompileArgs(parser: ArgumentParser) {
  parser.add_argument("--terminate-on-failure", {
    action: "store_true",
    help: "If provided, terminates on a failing eval, instead of the default (moving onto the next one).",
  });
  parser.add_argument("--tsconfig", {
    help: "Specify a custom tsconfig.json file to use.",
  });
  parser.add_argument("--external-packages", {
    nargs: "*",
    help: "Additional packages to mark as external during bundling. These packages will not be included in the bundle and must be available at runtime. Use this to resolve bundling errors with native modules or problematic dependencies. Example: --external-packages sqlite3 fsevents @mapbox/node-pre-gyp",
  });
}

async function main() {
  const parser = new ArgumentParser({
    description: "Braintrust CLI",
  });

  parser.add_argument("-v", "--version", { action: "version", version });

  const parentParser = new ArgumentParser({ add_help: false });
  parentParser.add_argument("--verbose", {
    action: "store_true",
    help: "Include additional details, including full stack traces on errors.",
  });

  const subparser = parser.add_subparsers({
    required: true,
  });

  const parser_run = subparser.add_parser("eval", {
    help: "Run evals locally.",
    parents: [parentParser],
  });
  addAuthArgs(parser_run);
  parser_run.add_argument("--filter", {
    help: "Only run evaluators that match these filters. Each filter is a regular expression (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp). For example, --filter metadata.priority='^P0$' input.name='foo.*bar' will only run evaluators that have metadata.priority equal to 'P0' and input.name matching the regular expression 'foo.*bar'.",
    nargs: "*",
  });
  parser_run.add_argument("--list", {
    help: "List, but do not execute, evaluators.",
    action: "store_true",
  });
  parser_run.add_argument("--jsonl", {
    action: "store_true",
    help: "Format score summaries as jsonl, i.e. one JSON-formatted line per summary.",
  });
  addCompileArgs(parser_run);
  parser_run.add_argument("--watch", {
    action: "store_true",
    help: "Watch files for changes and rerun evals when changes are detected",
  });
  parser_run.add_argument("--no-send-logs", {
    action: "store_true",
    help: "Do not send logs to Braintrust. Useful for testing evaluators without uploading results.",
  });
  parser_run.add_argument("--no-progress-bars", {
    action: "store_true",
    help: "Do not show progress bars when processing evaluators.",
  });
  parser_run.add_argument("--bundle", {
    action: "store_true",
    help: "Experimental (do not use unless you know what you're doing)",
  });
  parser_run.add_argument("--push", {
    action: "store_true",
    help: "Push the scorers from the current run to Braintrust. This will mark the current run's scorers as the latest version in the project.",
  });
  parser_run.add_argument("files", {
    nargs: "*",
    help: "A list of files or directories to run. If no files are specified, the current directory is used.",
  });
  parser_run.add_argument("--dev", {
    action: "store_true",
    help: "Run the evaluators in dev mode. This will start a dev server which you can connect to via the playground's remote evals feature.",
  });
  parser_run.add_argument("--dev-host", {
    help: "The host to bind the dev server to. Defaults to localhost. Set to 0.0.0.0 to bind to all interfaces.",
    type: String,
    default: "localhost",
  });
  parser_run.add_argument("--dev-port", {
    help: "The port to bind the dev server to. Defaults to 8300.",
    type: Number,
    default: 8300,
  });
  parser_run.add_argument("--dev-org-name", {
    help: "Only allow users that belong this to this org name to run remote evals.",
    type: String,
  });
  parser_run.set_defaults({ func: run });

  const parser_push = subparser.add_parser("push", {
    help: "Bundle prompts, tools, scorers, and other resources into Braintrust",
  });
  addAuthArgs(parser_push);
  addCompileArgs(parser_push);
  parser_push.add_argument("files", {
    nargs: "*",
    help: "A list of files or directories containing functions to bundle. If no files are specified, the current directory is used.",
  });
  parser_push.add_argument("--if-exists", {
    choices: ["error", "replace", "ignore"],
    default: "error",
    help: "What to do if a function with the same slug already exists. 'error' will cause an error and abort. 'replace' will overwrite the existing function. 'ignore' will ignore the push for this function and continue.",
  });
  parser_push.set_defaults({ func: bundleCommand });

  const parser_pull = subparser.add_parser("pull", {
    help: "Pull prompts, tools, scorers, and other resources from Braintrust to save in your codebase.",
  });
  parser_pull.add_argument("--output-dir", {
    help: "The directory to output the pulled resources to. If not specified, the current directory is used.",
  });
  parser_pull.add_argument("--project-name", {
    help: "The name of the project to pull from. If not specified, all projects are pulled.",
  });
  parser_pull.add_argument("--project-id", {
    help: "The id of the project to pull from. If not specified, all projects are pulled.",
  });
  parser_pull.add_argument("--id", {
    help: "The id of a specific function to pull.",
  });
  parser_pull.add_argument("--slug", {
    help: "The slug of a specific function to pull.",
  });
  parser_pull.add_argument("--version", {
    help: "The version to pull. Will pull the latest version of each prompt that is at or before this version.",
  });
  parser_pull.add_argument("--force", {
    action: "store_true",
    help: "Overwrite local files if they have uncommitted changes.",
  });
  parser_pull.set_defaults({ func: pullCommand });

  const parsed = parser.parse_args();

  try {
    await parsed.func(parsed);
  } catch (e) {
    logError(e, parsed.verbose);
    process.exit(1);
  }
}

main();
