import type {
  CustomTransform,
  InstrumentationConfig,
  InstrumentationMatcher,
} from "@apm-js-collab/code-transformer";
import { create } from "@apm-js-collab/code-transformer";

// @ts-expect-error Internal code-transformer helpers are not part of the public API.
import * as codeTransformerTransforms from "@apm-js-collab/code-transformer/lib/transforms.js";

export const mastraAssignedAsyncTransformName = "braintrustMastraAssignedAsync";

const tracePromiseTransform =
  (
    codeTransformerTransforms as {
      default?: {
        tracePromise?: CustomTransform;
      };
      tracePromise?: CustomTransform;
    }
  ).tracePromise ??
  (
    codeTransformerTransforms as {
      default?: {
        tracePromise?: CustomTransform;
      };
    }
  ).default?.tracePromise;

if (!tracePromiseTransform) {
  throw new Error(
    "Failed to resolve code-transformer tracePromise helper for Mastra instrumentation.",
  );
}

/**
 * Mastra assigns `Tool.execute` in the constructor with an async arrow function.
 *
 * The generic expression wrapper preserves arrow semantics, which means
 * diagnostics context sees the constructor's lexical `arguments` instead of the
 * runtime `(inputData, context)` passed to `Tool.execute`. Convert that assigned
 * arrow into a function expression before delegating to the standard async
 * wrapper so channel events capture the real call arguments.
 */
const traceMastraAssignedAsync: CustomTransform = (
  state,
  node,
  parent,
  ancestry,
) => {
  if (node.type === "ArrowFunctionExpression") {
    Object.assign(node, {
      type: "FunctionExpression",
      id: null,
      expression: false,
    });
  }

  return tracePromiseTransform(
    {
      ...(state as Record<string, unknown>),
      operator: "tracePromise",
    },
    node,
    parent,
    ancestry,
  );
};

export function createInstrumentationMatcher(
  instrumentations: InstrumentationConfig[],
  dcModule?: string | null,
): InstrumentationMatcher {
  const matcher = create(instrumentations, dcModule ?? null);
  matcher.addTransform(
    mastraAssignedAsyncTransformName,
    traceMastraAssignedAsync,
  );
  return matcher;
}
