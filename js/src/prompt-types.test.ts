import { expectTypeOf, test } from "vitest";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { CompletionCreateParamsNonStreaming } from "openai/resources/completions";
import {
  Prompt,
  type CompiledPrompt,
  type CompiledPromptParams,
  type DefaultPromptArgs,
  type PromptRowWithId,
} from "./logger";
import type { CodeParameters, CodePrompt } from "./framework2";
import type {
  AnyModelParamsType,
  FunctionDataType,
  PromptDataType,
  PromptType,
} from "./generated_plain_types";

test("compiled prompts preserve provider parameter types and compatibility", () => {
  // The generated backend types are a compatibility reference, not the public API.
  type BackendParams = Omit<
    AnyModelParamsType,
    "use_cache" | "response_format" | "reasoning_effort"
  > & { model: string };
  type Params = Omit<
    CompiledPromptParams,
    "response_format" | "reasoning_effort"
  >;
  expectTypeOf<Params>().toMatchTypeOf<BackendParams>();
  expectTypeOf<BackendParams>().toMatchTypeOf<Params>();
  expectTypeOf<keyof Params>().toEqualTypeOf<keyof BackendParams>();
  expectTypeOf<
    CompiledPrompt<"chat">
  >().toMatchTypeOf<ChatCompletionCreateParamsNonStreaming>();
  expectTypeOf<
    CompiledPrompt<"completion">
  >().toMatchTypeOf<CompletionCreateParamsNonStreaming>();
  expectTypeOf<CompiledPromptParams["reasoning_effort"]>().toEqualTypeOf<
    "minimal" | "low" | "medium" | "high" | undefined
  >();
  expectTypeOf<DefaultPromptArgs["use_cache"]>().toEqualTypeOf<
    boolean | undefined
  >();

  if (false) {
    const prompt = null as unknown as Prompt;
    // @ts-expect-error Cache serialization is internal, not a Prompt method.
    prompt._internalSerializeForCache();
    expectTypeOf(prompt.build({})).toEqualTypeOf<CompiledPrompt<"chat">>();
    expectTypeOf(prompt.build({}, { flavor: "completion" })).toEqualTypeOf<
      CompiledPrompt<"completion">
    >();
    expectTypeOf(prompt.buildWithAttachments({})).toEqualTypeOf<
      Promise<CompiledPrompt<"chat">>
    >();
    const defaults: DefaultPromptArgs = {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "result",
          schema: { type: "object" },
          strict: null,
        },
      },
      use_cache: true,
    };
    new Prompt(
      { id: "id", _xact_id: "version", name: "name", slug: "slug" },
      defaults,
      false,
    );
    defaults.response_format = {
      type: "json_schema",
      json_schema: {
        name: "result",
        // @ts-expect-error Compiled schemas are objects, not templates.
        schema: "{{schema}}",
      },
    };
    // @ts-expect-error Preserve compatibility with older OpenAI clients.
    defaults.reasoning_effort = "none";
  }
});

test("prompt metadata preserves required and optional identifiers", () => {
  type Metadata = Omit<
    PromptType,
    "log_id" | "org_id" | "project_id" | "id" | "_xact_id"
  > & {
    project_id?: string;
  };
  type RequiredRow = Metadata & { id: string; _xact_id: string };
  type OptionalRow = Metadata & { id?: string; _xact_id?: string };
  expectTypeOf<PromptRowWithId<true, true>>().toMatchTypeOf<RequiredRow>();
  expectTypeOf<RequiredRow>().toMatchTypeOf<PromptRowWithId<true, true>>();
  expectTypeOf<keyof PromptRowWithId>().toEqualTypeOf<keyof RequiredRow>();
  expectTypeOf<PromptRowWithId<false, false>>().toMatchTypeOf<OptionalRow>();
  expectTypeOf<OptionalRow>().toMatchTypeOf<PromptRowWithId<false, false>>();
  expectTypeOf<PromptRowWithId<true, false>["id"]>().toEqualTypeOf<string>();
  expectTypeOf<PromptRowWithId<true, false>["_xact_id"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<PromptRowWithId<false, true>["id"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<
    PromptRowWithId<false, true>["_xact_id"]
  >().toEqualTypeOf<string>();
  expectTypeOf<Prompt<true, true>["id"]>().toEqualTypeOf<string>();
  expectTypeOf<Prompt<false, false>["id"]>().toEqualTypeOf<
    string | undefined
  >();
});

test("function definitions expose only the variant each builder produces", () => {
  type PromptEvent = Awaited<ReturnType<CodePrompt["toFunctionDefinition"]>>;
  type ParametersEvent = Awaited<
    ReturnType<CodeParameters["toFunctionDefinition"]>
  >;
  expectTypeOf<PromptEvent["function_data"]>().toEqualTypeOf<{
    type: "prompt";
  }>();
  expectTypeOf<
    PromptEvent["prompt_data"]
  >().branded.toEqualTypeOf<PromptDataType>();
  expectTypeOf<
    ParametersEvent["function_data"]["type"]
  >().toEqualTypeOf<"parameters">();
  expectTypeOf<
    ParametersEvent["function_type"]
  >().toEqualTypeOf<"parameters">();
  expectTypeOf<ParametersEvent["function_data"]>().toMatchTypeOf<
    Extract<FunctionDataType, { type: "parameters" }>
  >();
});
