import { isObject } from "../../../util";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { traceAsyncCall } from "../core/tracing";
import { runInstrumentation } from "../core/observe-result";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { retellChannels } from "./retell-interceptors";
import { observeRetellResponse } from "../../wrappers/retell-promise";

function pick(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    keys.flatMap((key) => {
      const field = value[key];
      return typeof field === "string" ||
        typeof field === "number" ||
        typeof field === "boolean"
        ? [[key, field]]
        : [];
    }),
  );
}

function messages(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isObject).flatMap((message) =>
    typeof message.content === "string" && typeof message.role === "string"
      ? [
          {
            role: message.role === "agent" ? "assistant" : message.role,
            content: message.content,
          },
        ]
      : [],
  );
}

export function registerRetellInstrumentation(): void {
  for (const [key, name] of [
    ["createPhoneCall", "call.createPhoneCall"],
    ["createWebCall", "call.createWebCall"],
    ["retrieveCall", "call.retrieve"],
    ["createChat", "chat.create"],
    ["createChatCompletion", "chat.createChatCompletion"],
  ] as const) {
    const hook = retellChannels[key];
    hook.intercept((target, self, args, additional) => {
      if (isAutoInstrumentationSuppressed())
        return Reflect.apply(target, self, args);
      let result: PromiseLike<unknown>;
      traceAsyncCall<typeof hook>(
        () => {
          result = runWithAutoInstrumentationSuppressed(() =>
            Reflect.apply(target, self, args),
          );
          return (
            runInstrumentation(() => observeRetellResponse(result)) ??
            Promise.resolve(undefined)
          );
        },
        { ...additional, arguments: args, self },
        {
          name: `retell.${name}`,
          instrumentationName: INSTRUMENTATION_NAMES.RETELL,
          // Session creation and retrieval measure API work, not a voice conversation.
          type: key === "createChatCompletion" ? "llm" : "task",
          extractInput: ([request]) => ({
            input:
              typeof request === "string"
                ? { call_id: request }
                : pick(request, [
                    "agent_id",
                    "agent_version",
                    "chat_id",
                    "content",
                  ]),
            metadata: { provider: "retell" },
          }),
          extractOutput: (result) => {
            if (!isObject(result)) return undefined;
            if (key === "createChatCompletion")
              return messages(result.messages);
            const output = pick(result, [
              "call_id",
              "chat_id",
              "agent_id",
              "agent_version",
              "call_type",
              "call_status",
              "chat_status",
            ]);
            if (key === "retrieveCall") {
              const transcript = messages(result.transcript_object);
              if (transcript) output.messages = transcript;
            }
            // In particular, web-call access tokens and transport credentials stay out.
            return output;
          },
          extractMetrics: () => ({}),
        },
      );
      return result!;
    });
  }
}
