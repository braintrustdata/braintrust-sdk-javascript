/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import esquery from "esquery";
import { parse } from "meriyah";
import {
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
  GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND,
  GLOBAL_INVOCATION_HOOK_BRAND,
} from "../../global-instrumentation-hooks";
import type { InstrumentationConfig } from "./types";

type AnyNode = any;
export interface TransformState extends InstrumentationConfig {
  moduleVersion: string;
}

const CHANNEL_REGEX = /[^\w]/g;
const SHARED_HOOK_LOOKUP = "tr_ch_bt$get_hook";

function formatChannelGetter(channelName: string): string {
  return `tr_ch_bt$get_${channelName.replace(CHANNEL_REGEX, "_")}`;
}

function declareInvocationHook(state: TransformState, node: AnyNode): void {
  const {
    channelName,
    module: { name },
  } = state;
  const channelVariable = `tr_ch_bt$${channelName.replace(CHANNEL_REGEX, "_")}`;
  const channelGetter = formatChannelGetter(channelName);
  const sharedHookLookupIndex = node.body.findIndex(
    (child: AnyNode) =>
      child.declarations?.[0]?.id?.name === SHARED_HOOK_LOOKUP,
  );

  if (
    node.body.some(
      (child: AnyNode) => child.declarations?.[0]?.id?.name === channelGetter,
    )
  ) {
    return;
  }

  const sharedHookLookup =
    sharedHookLookupIndex !== -1
      ? ""
      : `
      const ${SHARED_HOOK_LOOKUP} = (__bt$hookName) => {
        try {
          const __bt$hooks = globalThis[${JSON.stringify(
            GLOBAL_INSTRUMENTATION_HOOKS_KEY,
          )}];
          if (
            !(__bt$hooks instanceof Map) ||
            __bt$hooks[Symbol.for(${JSON.stringify(
              GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND,
            )})] !== ${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION}
          ) return undefined;
          const __bt$hook = Map.prototype.get.call(
            __bt$hooks,
            __bt$hookName
          );
          if (
            (__bt$hook === null ||
              (typeof __bt$hook !== "object" &&
                typeof __bt$hook !== "function")) ||
            __bt$hook[Symbol.for(${JSON.stringify(
              GLOBAL_INVOCATION_HOOK_BRAND,
            )})] !== ${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION} ||
            typeof __bt$hook.invoke !== "function"
          ) return undefined;
          return __bt$hook;
        } catch {
          return undefined;
        }
      };
    `;
  const code = `
      ${sharedHookLookup}
      let ${channelVariable};
      const ${channelGetter} = () =>
        ${channelVariable} ??= ${SHARED_HOOK_LOOKUP}(
          ${JSON.stringify(`orchestrion:${name}:${channelName}`)}
        );
    `;

  const index =
    sharedHookLookupIndex === -1
      ? node.body.findIndex(
          (child: AnyNode) => child.directive === "use strict",
        )
      : sharedHookLookupIndex;
  node.body.splice(index + 1, 0, ...parse(code).body);
}

export function wrapInvocation(
  state: TransformState,
  node: AnyNode,
  program: AnyNode,
): void {
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    wrapInstanceMethod(state, node, program);
  } else {
    wrapFunction(state, node, program);
  }
}

function wrapFunction(
  state: TransformState,
  node: AnyNode,
  program: AnyNode,
): void {
  declareInvocationHook(state, program);

  const isArrowFunction = node.type === "ArrowFunctionExpression";

  node.body = wrap(
    state,
    {
      type: isArrowFunction ? "ArrowFunctionExpression" : "FunctionExpression",
      params: node.params,
      body: node.body,
      async: node.async,
      expression: false,
      generator: node.generator,
    },
    isArrowFunction ? "__bt$args" : "arguments",
  );

  // Arrow functions do not have their own `arguments` object. Give the
  // generated wrapper an explicit rest parameter so it forwards the call's
  // arguments rather than capturing the enclosing scope's `arguments`.
  if (isArrowFunction) {
    node.params = [
      {
        type: "RestElement",
        argument: { type: "Identifier", name: "__bt$args" },
      },
    ];
  }

  node.generator = false;
  node.async = false;

  wrapSuper(node);
}

function wrapInstanceMethod(
  state: TransformState,
  node: AnyNode,
  program: AnyNode,
): void {
  const { functionQuery } = state;
  const { methodName } = functionQuery as any;

  if (!methodName) {
    return;
  }

  const classBody = node.body;

  if (classBody.body.some(({ key }: AnyNode) => key?.name === methodName)) {
    return;
  }

  let ctor = classBody.body.find(({ kind }: AnyNode) => kind === "constructor");

  declareInvocationHook(state, program);

  if (!ctor) {
    ctor = (
      parse(
        node.superClass
          ? "class A extends Object { constructor (...args) { super(...args) } }"
          : "class A { constructor () {} }",
      ) as any
    ).body[0].body.body[0];

    classBody.body.unshift(ctor);
  }

  const ctorBody = (
    parse(`
    const __bt$${methodName} = this["${methodName}"]
    this["${methodName}"] = function () {}
  `) as any
  ).body;

  const fn = ctorBody[1].expression.right;

  fn.body = wrap(
    state,
    {
      type: "Identifier",
      name: `__bt$${methodName}`,
    },
    "arguments",
  );

  ctor.value.body.body.push(...ctorBody);
}

function wrap(
  state: TransformState,
  node: AnyNode,
  argsExpression: string,
): AnyNode {
  const wrapper: AnyNode = parse(`
    function wrapper () {
      const __bt$target = () => {};
      const __bt$hook = ${formatChannelGetter(state.channelName)}();
      if (!__bt$hook) return __bt$target.apply(this, ${argsExpression});
      return __bt$hook.invoke(
        __bt$target,
        this,
        ${argsExpression},
        { moduleVersion: ${JSON.stringify(state.moduleVersion)} }
      );
    }
  `).body[0];
  const block = wrapper.body;
  block.body[0].declarations[0].init = node;
  return block;
}

function wrapSuper(node: AnyNode): void {
  const members = new Set<string>();

  esquery.traverse(
    node.body,
    esquery.parse("[object.type=Super]"),
    (node: AnyNode, parent: AnyNode) => {
      const { name } = node.property;

      let child: AnyNode;

      if (parent.callee) {
        const { expression } = (
          parse(`__bt$super['${name}'].call(this)`) as any
        ).body[0];

        parent.callee = child = expression.callee;
        parent.arguments.unshift(...expression.arguments);
      } else {
        parent.expression = child = parse(`__bt$super['${name}']`).body[0];
      }

      child.computed = parent.callee.computed;
      child.optional = parent.callee.optional;

      members.add(name);
    },
  );

  for (const name of members) {
    const member = (
      parse(`
      class Wrapper {
        wrapper () {
          __bt$super['${name}'] = super['${name}']
        }
      }
    `) as any
    ).body[0].body.body[0].value.body.body[0];

    node.body.body.unshift(member);
  }

  if (members.size > 0) {
    node.body.body.unshift(parse("const __bt$super = {}").body[0]);
  }
}
