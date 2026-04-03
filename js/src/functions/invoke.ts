import {
  FunctionId as functionIdSchema,
  type InvokeFunctionType as InvokeFunctionRequest,
  type ChatCompletionMessageParamType as Message,
  type StreamingModeType as StreamingMode,
  type FunctionTypeEnumType as FunctionType,
} from "../generated_types";
import {
  _internalGetGlobalState,
  BraintrustState,
  Exportable,
  FullLoginOptions,
  getSpanParentObject,
} from "../logger";
import { BraintrustStream } from "./stream";
import { z } from "zod/v3";

/**
 * Arguments for the `invoke` function.
 */
export interface InvokeFunctionArgs<
  Input,
  Output,
  Stream extends boolean = false,
> {
  // These parameters are duplicated from FunctionId, so that we can document them.

  /**
   * The ID of the function to invoke.
   */
  function_id?: string;

  /**
   * The name of the project containing the function to invoke.
   */
  projectName?: string;
  /**
   * The ID of the project to use for execution context (API keys, project defaults, etc.).
   * This is not the project the function belongs to, but the project context for the invocation.
   */
  projectId?: string;
  /**
   * The slug of the function to invoke.
   */
  slug?: string;

  /**
   * The name of the global function to invoke.
   */
  globalFunction?: string;
  /**
   * The type of the global function to invoke. If unspecified, defaults to 'scorer' for backward compatibility.
   */
  functionType?: FunctionType;
  /**
   * The ID of the prompt session to invoke the function from.
   */
  promptSessionId?: string;
  /**
   * The ID of the function in the prompt session to invoke.
   */
  promptSessionFunctionId?: string;

  /**
   * The version of the function to invoke.
   */
  version?: string;

  /**
   * The input to the function. This will be logged as the `input` field in the span.
   */
  input: Input;

  /**
   * Additional OpenAI-style messages to add to the prompt (only works for llm functions).
   */
  messages?: Message[];

  /**
   * Additional metadata to add to the span. This will be logged as the `metadata` field in the span.
   * It will also be available as the {{metadata}} field in the prompt and as the `metadata` argument
   * to the function.
   */
  metadata?: Record<string, unknown>;
  /**
   * Tags to add to the span. This will be logged as the `tags` field in the span.
   */
  tags?: string[];

  /**
   * The parent of the function. This can be an existing span, logger, or experiment, or
   * the output of `.export()` if you are distributed tracing. If unspecified, will use
   * the same semantics as `traced()` to determine the parent and no-op if not in a tracing
   * context.
   */
  parent?: Exportable | string;
  /**
   * Whether to stream the function's output. If true, the function will return a
   * `BraintrustStream`, otherwise it will return the output of the function as a JSON
   * object.
   */
  stream?: Stream;
  /**
   * The mode of the function. If "auto", will return a string if the function returns a string,
   * and a JSON object otherwise. If "parallel", will return an array of JSON objects with one
   * object per tool call.
   */
  mode?: StreamingMode;
  /**
   * Whether to use strict mode for the function. If true, the function will throw an error
   * if the variable names in the prompt do not match the input keys.
   */
  strict?: boolean;
  /**
   * A Zod schema to validate the output of the function and return a typed value. This
   * is only used if `stream` is false.
   */
  schema?: Stream extends true ? never : z.ZodSchema<Output>;
  /**
   * (Advanced) This parameter allows you to pass in a custom login state. This is useful
   * for multi-tenant environments where you are running functions from different Braintrust
   * organizations.
   */
  state?: BraintrustState;
}

/**
 * The return type of the `invoke` function. Conditionally returns a `BraintrustStream`
 * if `stream` is true, otherwise returns the output of the function using the Zod schema's
 * type if present.
 */
export type InvokeReturn<Stream extends boolean, Output> = Stream extends true
  ? BraintrustStream
  : Output;

/**
 * Invoke a Braintrust function, returning a `BraintrustStream` or the value as a plain
 * Javascript object.
 *
 * @param args The arguments for the function (see {@link InvokeFunctionArgs} for more details).
 * @returns The output of the function.
 */
export async function invoke<Input, Output, Stream extends boolean = false>(
  args: InvokeFunctionArgs<Input, Output, Stream> & FullLoginOptions,
): Promise<InvokeReturn<Stream, Output>> {
  const {
    orgName,
    apiKey,
    appUrl,
    forceLogin,
    fetch,
    input,
    messages,
    parent: parentArg,
    metadata,
    tags,
    state: stateArg,
    stream,
    mode,
    schema,
    strict,
    projectId,
    ...functionIdArgs
  } = args;

  const state = stateArg ?? _internalGetGlobalState();
  await state.login({
    orgName: orgName,
    apiKey,
    appUrl,
    forceLogin,
    fetch,
  });

  const parent = parentArg
    ? typeof parentArg === "string"
      ? parentArg
      : await parentArg.export()
    : await getSpanParentObject().export();

  const functionId = functionIdSchema.safeParse({
    function_id: functionIdArgs.function_id,
    project_name: functionIdArgs.projectName,
    slug: functionIdArgs.slug,
    global_function: functionIdArgs.globalFunction,
    function_type: functionIdArgs.functionType,
    prompt_session_id: functionIdArgs.promptSessionId,
    prompt_session_function_id: functionIdArgs.promptSessionFunctionId,
    version: functionIdArgs.version,
  });
  if (!functionId.success) {
    throw new Error(
      `Invalid function ID arguments: ${functionId.error.message}`,
    );
  }

  const request: InvokeFunctionRequest = {
    ...functionId.data,
    input,
    messages,
    parent,
    metadata,
    tags,
    stream,
    mode,
    strict,
  };

  const headers: Record<string, string> = {
    Accept: stream ? "text/event-stream" : "application/json",
  };
  const effectiveOrgName = orgName ?? state.orgName;
  if (projectId) {
    headers["x-bt-project-id"] = projectId;
  }
  if (effectiveOrgName) {
    headers["x-bt-org-name"] = effectiveOrgName;
  }

  const resp = await state.proxyConn().post(`function/invoke`, request, {
    headers,
  });

  if (stream) {
    if (!resp.body) {
      throw new Error("Received empty stream body");
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return new BraintrustStream(resp.body) as InvokeReturn<Stream, Output>;
  } else {
    const data = await resp.json();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return (schema ? schema.parse(data) : data) as InvokeReturn<Stream, Output>;
  }
}

/**
 * Creates a function that can be used as a task or scorer in the Braintrust evaluation framework.
 * The returned function wraps a Braintrust function and can be passed directly to Eval().
 *
 * When used as a task:
 * ```ts
 * const myFunction = initFunction({projectName: "myproject", slug: "myfunction"});
 * await Eval("test", {
 *   task: myFunction,
 *   data: testData,
 *   scores: [...]
 * });
 * ```
 *
 * When used as a scorer:
 * ```ts
 * const myScorer = initFunction({projectName: "myproject", slug: "myscorer"});
 * await Eval("test", {
 *   task: someTask,
 *   data: testData,
 *   scores: [myScorer]
 * });
 * ```
 *
 * @param options Options for the function.
 * @param options.projectName The project name containing the function.
 * @param options.slug The slug of the function to invoke.
 * @param options.version Optional version of the function to use. Defaults to latest.
 * @param options.state Optional Braintrust state to use.
 * @returns A function that can be used as a task or scorer in Eval().
 */
export function initFunction({
  projectName,
  slug,
  version,
  state,
}: {
  projectName: string;
  slug: string;
  version?: string;
  state?: BraintrustState;
}) {
  // Disable span cache since remote function spans won't be in the local cache
  const s = state ?? _internalGetGlobalState();
  s?.spanCache?.disable();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = async (input: any): Promise<any> => {
    return await invoke({
      projectName,
      slug,
      version,
      input,
    });
  };

  Object.defineProperty(f, "name", {
    value: `initFunction-${projectName}-${slug}-${version ?? "latest"}`,
  });
  return f;
}
