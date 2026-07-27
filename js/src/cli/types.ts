import type * as esbuild from "esbuild";
import type { BaseMetadata } from "../logger";
import type { EvaluatorDef, EvaluatorFile } from "../framework";
import type { ReporterDef } from "../reporters/types";
import type { DurableEvalDefinition } from "../durable-eval";

export interface BuildSuccess {
  type: "success";
  result: esbuild.BuildResult;
  evaluator: EvaluatorFile;
  sourceFile: string;
}

export interface BuildFailure {
  type: "failure";
  error: Error;
  sourceFile: string;
}

export type BtBuildResult = BuildSuccess | BuildFailure;

export interface FileHandle {
  inFile: string;
  outFile: string;
  bundleFile?: string;
  rebuild: () => Promise<BtBuildResult>;
  bundle: () => Promise<esbuild.BuildResult>;
  watch: () => void;
  destroy: () => Promise<void>;
}

export interface EvaluatorState {
  evaluators: {
    sourceFile: string;
    evaluator: EvaluatorDef<unknown, unknown, unknown, BaseMetadata>;
    reporter: string | ReporterDef<unknown> | undefined;
  }[];
  durableEvaluators: {
    sourceFile: string;
    // Runtime registration has already passed the public generic boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    definition: DurableEvalDefinition<any, any, any, any, any>;
  }[];
  reporters: {
    [reporter: string]: ReporterDef<unknown>;
  };
}
