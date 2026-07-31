/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import esquery from "esquery";
import { parse } from "meriyah";
import {
  GLOBAL_INSTRUMENTATION_HOOK_BRAND,
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
  GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND,
} from "../../global-instrumentation-hooks";
import type { FunctionQuery, InstrumentationConfig } from "./types";

type AnyNode = any;
type TransformFn = (
  state: TransformState,
  node: AnyNode,
  parent: AnyNode,
  ancestry: AnyNode[],
) => void;
type TraceOperator = "traceCallback" | "tracePromise" | "traceSync";

export interface TransformState extends InstrumentationConfig {
  moduleVersion: string;
  functionQuery: FunctionQuery;
  operator: TraceOperator;
  functionIndex?: number;
}

const CHANNEL_REGEX = /[^\w]/g;
const SHARED_HOOK_LOOKUP = "tr_ch_bt$get_hook";

function formatChannelVariable(channelName: string): string {
  return `tr_ch_bt$${channelName.replace(CHANNEL_REGEX, "_")}`;
}

function formatChannelGetter(channelName: string): string {
  return `tr_ch_bt$get_${channelName.replace(CHANNEL_REGEX, "_")}`;
}

export const transforms: Record<string, TransformFn> = {
  tracingHookDeclaration(state, node) {
    const {
      channelName,
      module: { name },
      operator,
    } = state;
    const channelVariable = formatChannelVariable(channelName);
    const channelGetter = formatChannelGetter(channelName);
    const hasSharedHookLookup = node.body.some(
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

    const sharedHookLookup = hasSharedHookLookup
      ? ""
      : `
      const ${SHARED_HOOK_LOOKUP} = (__bt$hookName, __bt$operator) => {
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
              GLOBAL_INSTRUMENTATION_HOOK_BRAND,
            )})] !== ${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION} ||
            typeof __bt$hook.hasSubscribers !== "boolean" ||
            typeof __bt$hook[__bt$operator] !== "function"
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
          ${JSON.stringify(`orchestrion:${name}:${channelName}`)},
          ${JSON.stringify(operator)}
        );
    `;

    const sharedHookLookupIndex = node.body.findIndex(
      (child: AnyNode) =>
        child.declarations?.[0]?.id?.name === SHARED_HOOK_LOOKUP,
    );
    const index =
      sharedHookLookupIndex === -1
        ? node.body.findIndex(
            (child: AnyNode) => child.directive === "use strict",
          )
        : sharedHookLookupIndex;
    node.body.splice(index + 1, 0, ...parse(code).body);
  },

  traceCallback: traceAny,
  tracePromise: traceAny,
  traceSync: traceAny,
};

function traceAny(
  state: TransformState,
  node: AnyNode,
  _parent: AnyNode,
  ancestry: AnyNode[],
): void {
  const program = ancestry[ancestry.length - 1];

  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    traceInstanceMethod(state, node, program);
  } else {
    traceFunction(state, node, program);
  }
}

function traceFunction(
  state: TransformState,
  node: AnyNode,
  program: AnyNode,
): void {
  transforms.tracingHookDeclaration(state, program, null, []);

  const { functionQuery } = state;
  const methodName =
    "methodName" in functionQuery ? functionQuery.methodName : undefined;
  const privateMethodName =
    "privateMethodName" in functionQuery
      ? functionQuery.privateMethodName
      : undefined;
  const functionName =
    "functionName" in functionQuery ? functionQuery.functionName : undefined;
  const isConstructor =
    methodName === "constructor" ||
    (!methodName && !privateMethodName && !functionName);
  const type = isConstructor ? "ArrowFunctionExpression" : "FunctionExpression";

  node.body = wrap(state, {
    type,
    params: node.params,
    body: node.body,
    async: node.async,
    expression: false,
    generator: node.generator,
  });

  node.generator = false;
  node.async = false;

  wrapSuper(node);
}

function traceInstanceMethod(
  state: TransformState,
  node: AnyNode,
  program: AnyNode,
): void {
  const { functionQuery, operator } = state;
  const { methodName } = functionQuery as any;

  if (!methodName) {
    return;
  }

  const classBody = node.body;

  if (classBody.body.some(({ key }: AnyNode) => key?.name === methodName)) {
    return;
  }

  let ctor = classBody.body.find(({ kind }: AnyNode) => kind === "constructor");

  transforms.tracingHookDeclaration(state, program, null, []);

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

  fn.async = operator === "tracePromise";
  fn.body = wrap(state, {
    type: "Identifier",
    name: `__bt$${methodName}`,
  });

  wrapSuper(fn);

  ctor.value.body.body.push(...ctorBody);
}

function wrap(state: TransformState, node: AnyNode): AnyNode {
  const { operator, moduleVersion } = state;

  const wrapper =
    operator === "traceCallback"
      ? wrapCallback(state)
      : operator === "tracePromise"
        ? wrapPromise(state)
        : wrapSync(state);

  const block = wrapper.body[0].body;
  const common = parse(
    node.type === "ArrowFunctionExpression"
      ? `
    const __bt$ctx = {
      arguments,
      moduleVersion: ${JSON.stringify(moduleVersion)}
    };
    const __bt$traced = () => {
      const __bt$wrapped = () => {};
      return __bt$wrapped(...arguments);
    };
  `
      : `
    const __bt$ctx = {
      arguments,
      self: this,
      moduleVersion: ${JSON.stringify(moduleVersion)}
    };
    const __bt$traced = () => {
      const __bt$wrapped = () => {};
      return __bt$wrapped.apply(this, arguments);
    };
  `,
  ).body;

  block.body.unshift(...common);

  (esquery.query(block, "[id.name=__bt$wrapped]")[0] as AnyNode).init = node;

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

function wrapCallback(state: TransformState): AnyNode {
  const {
    channelName,
    functionQuery: { callbackIndex = -1 },
  } = state;
  const channelGetter = formatChannelGetter(channelName);

  return parse(`
    function wrapper () {
      const __bt$hook = ${channelGetter}();
      if (!__bt$hook?.hasSubscribers) return __bt$traced();
      __bt$ctx.self ??= this;
      return __bt$hook.traceCallback(
        __bt$traced,
        ${callbackIndex},
        __bt$ctx
      );
    }
  `);
}

function wrapPromise(state: TransformState): AnyNode {
  const { channelName } = state;
  const channelGetter = formatChannelGetter(channelName);

  return parse(`
    function wrapper () {
      const __bt$hook = ${channelGetter}();
      if (!__bt$hook?.hasSubscribers) return __bt$traced();
      __bt$ctx.self ??= this;
      return __bt$hook.tracePromise(__bt$traced, __bt$ctx);
    }
  `);
}

function wrapSync(state: TransformState): AnyNode {
  const { channelName } = state;
  const channelGetter = formatChannelGetter(channelName);

  return parse(`
    function wrapper () {
      const __bt$hook = ${channelGetter}();
      if (!__bt$hook?.hasSubscribers) return __bt$traced();
      __bt$ctx.self ??= this;
      return __bt$hook.traceSync(__bt$traced, __bt$ctx);
    }
  `);
}
