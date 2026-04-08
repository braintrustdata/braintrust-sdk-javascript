import { z } from "zod/v3";
import { slugify } from "../util/string_util";
import { type IfExistsType } from "./generated_types";
import { type BraintrustState, _internalGetGlobalState } from "./logger";

/**
 * Configuration for a sandbox runtime.
 * @internal
 */
export interface SandboxConfig {
  /** The sandbox provider. Currently only "modal" is supported. */
  provider: "modal";
  /** Reference to the sandbox snapshot. */
  snapshotRef: string;
}

/**
 * Options for registering a sandbox function.
 * @internal
 */
export interface RegisterSandboxOptions {
  /** Group name for the sandbox functions. */
  name: string;
  /** Name of the project to register the sandbox in. */
  project: string;
  /** Sandbox configuration (provider and snapshot reference). */
  sandbox: SandboxConfig;
  /** Optional list of entrypoints available in the sandbox. */
  entrypoints?: string[];
  /** Optional description. */
  description?: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
  /** What to do if function already exists. Defaults to "replace". */
  ifExists?: IfExistsType;
  /** Braintrust API key. Uses BRAINTRUST_API_KEY env var if not provided. */
  apiKey?: string;
  /** Braintrust app URL. Uses default if not provided. */
  appUrl?: string;
  /** Organization name. */
  orgName?: string;
  /** Optional BraintrustState instance. Defaults to the global state. */
  state?: BraintrustState;
}

/**
 * Result of registering a sandbox.
 * @internal
 */
export interface RegisterSandboxResult {
  /** Project ID the sandbox is registered in. */
  projectId: string;
  /** Registered eval functions discovered from this sandbox. */
  functions: {
    /** Eval name discovered from sandbox list endpoint. */
    evalName: string;
    /** Unique identifier for the function. */
    id: string;
    /** Function name. */
    name: string;
    /** URL-friendly identifier. */
    slug: string;
  }[];
}

const SANDBOX_GROUP_NAME_METADATA_KEY = "_bt_sandbox_group_name";

/**
 * Register a sandbox function with Braintrust.
 *
 * @param options Configuration for the sandbox to register.
 * @returns The registered sandbox function details.
 * @internal
 *
 * @example
 * ```typescript
 * const result = await registerSandbox({
 *   name: "My Sandbox",
 *   project: "My Project",
 *   entrypoints: ["./my-eval.eval.ts"],
 *   sandbox: {
 *     provider: "modal",
 *     snapshotRef: "sb-xxx",
 *   },
 * });
 * console.log(result.functions.map((f) => f.id));
 * ```
 */
export async function registerSandbox(
  options: RegisterSandboxOptions,
): Promise<RegisterSandboxResult> {
  const state = options.state ?? _internalGetGlobalState();
  await state.login({
    apiKey: options.apiKey,
    appUrl: options.appUrl,
    orgName: options.orgName,
  });

  // Get project ID via project registration
  const projectResponse = await state
    .appConn()
    .post_json("api/project/register", {
      project_name: options.project,
      org_id: state.orgId,
    });
  const projectId = projectResponse.project.id;
  if (!state.orgName) {
    throw new Error("Organization name is required to register sandbox evals");
  }

  const runtimeContext = {
    runtime: "node",
    version: process.version.slice(1),
  } as const;

  const listResponse = await state.proxyConn().post(
    "function/sandbox-list",
    {
      sandbox_spec: {
        provider: options.sandbox.provider,
        snapshot_ref: options.sandbox.snapshotRef,
      },
      runtime_context: runtimeContext,
      entrypoints: options.entrypoints,
      project_id: projectId,
    },
    {
      headers: {
        "x-bt-org-name": state.orgName,
      },
    },
  );
  const evaluatorDefinitions = z
    .record(z.unknown())
    .parse(await listResponse.json());

  const functions: RegisterSandboxResult["functions"] = [];
  for (const [evalName, evaluatorDefinition] of Object.entries(
    evaluatorDefinitions,
  )) {
    const functionName = evalName;
    const functionSlug = slugify(evalName, { lower: true, strict: true });

    const functionDef: Record<string, unknown> = {
      project_id: projectId,
      org_name: state.orgName,
      name: functionName,
      slug: functionSlug,
      function_type: "sandbox",
      function_data: {
        type: "code",
        data: {
          type: "bundle",
          runtime_context: runtimeContext,
          location: {
            type: "sandbox",
            sandbox_spec: {
              provider: options.sandbox.provider,
              snapshot_ref: options.sandbox.snapshotRef,
            },
            entrypoints: options.entrypoints,
            eval_name: evalName,
            evaluator_definition: evaluatorDefinition,
          },
          bundle_id: null,
          preview: null,
        },
      },
      metadata: {
        ...(options.metadata ?? {}),
        [SANDBOX_GROUP_NAME_METADATA_KEY]: options.name,
      },
      if_exists: options.ifExists ?? "replace",
    };
    if (options.description !== undefined) {
      functionDef.description = options.description;
    }

    const response = await state
      .apiConn()
      .post_json("v1/function", functionDef);
    functions.push({
      evalName,
      id: response.id,
      name: response.name,
      slug: response.slug,
    });
  }

  return {
    projectId,
    functions,
  };
}
