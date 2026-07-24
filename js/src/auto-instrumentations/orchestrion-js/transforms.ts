/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import esquery from "esquery";
import { parse } from "meriyah";
import { GLOBAL_INSTRUMENTATION_HOOKS_KEY } from "../../global-instrumentation-hooks";
import type { FunctionQuery, InstrumentationConfig, ModuleType } from "./types";

type AnyNode = any;
type TransformFn = (
  state: TransformState,
  node: AnyNode,
  parent: AnyNode,
  ancestry: AnyNode[],
) => void;
type TraceOperator = "traceCallback" | "tracePromise" | "traceSync";

export interface TransformState extends InstrumentationConfig {
  moduleType: ModuleType;
  moduleVersion: string;
  functionQuery: FunctionQuery;
  operator: TraceOperator;
  functionIndex?: number;
}

const CHANNEL_REGEX = /[^\w]/g;

function formatChannelVariable(channelName: string): string {
  return `tr_ch_apm$${channelName.replace(CHANNEL_REGEX, "_")}`;
}

function formatChannelGetter(channelName: string): string {
  return `tr_ch_apm$get_${channelName.replace(CHANNEL_REGEX, "_")}`;
}

export const transforms: Record<string, TransformFn> = {
  tracingHookDeclaration(state, node) {
    const {
      channelName,
      module: { name },
    } = state;
    const channelVariable = formatChannelVariable(channelName);
    const channelGetter = formatChannelGetter(channelName);

    if (
      node.body.some(
        (child: AnyNode) => child.declarations?.[0]?.id?.name === channelGetter,
      )
    ) {
      return;
    }

    const index = node.body.findIndex(
      (child: AnyNode) => child.directive === "use strict",
    );
    const code = `
      let ${channelVariable};
      const ${channelGetter} = () => ${channelVariable} ??= globalThis[${JSON.stringify(
        GLOBAL_INSTRUMENTATION_HOOKS_KEY,
      )}]?.get?.("orchestrion:${name}:${channelName}");
    `;

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

  node.body = wrap(
    state,
    {
      type,
      params: node.params,
      body: node.body,
      async: node.async,
      expression: false,
      generator: node.generator,
    },
    program,
  );

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

  if (classBody.body.some(({ key }: AnyNode) => key.name === methodName)) {
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
    const __apm$${methodName} = this["${methodName}"]
    this["${methodName}"] = function () {}
  `) as any
  ).body;

  const fn = ctorBody[1].expression.right;

  fn.async = operator === "tracePromise";
  fn.body = wrap(
    state,
    { type: "Identifier", name: `__apm$${methodName}` },
    program,
  );

  wrapSuper(fn);

  ctor.value.body.body.push(...ctorBody);
}

function wrap(
  state: TransformState,
  node: AnyNode,
  program?: AnyNode,
): AnyNode {
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
    const __apm$ctx = {
      arguments,
      moduleVersion: ${JSON.stringify(moduleVersion)}
    };
    const __apm$traced = () => {
      const __apm$wrapped = () => {};
      return __apm$wrapped(...arguments);
    };
  `
      : `
    const __apm$ctx = {
      arguments,
      self: this,
      moduleVersion: ${JSON.stringify(moduleVersion)}
    };
    const __apm$traced = () => {
      const __apm$wrapped = () => {};
      return __apm$wrapped.apply(this, arguments);
    };
  `,
  ).body;

  block.body.unshift(...common);

  (esquery.query(block, "[id.name=__apm$wrapped]")[0] as AnyNode).init = node;

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
          parse(`__apm$super['${name}'].call(this)`) as any
        ).body[0];

        parent.callee = child = expression.callee;
        parent.arguments.unshift(...expression.arguments);
      } else {
        parent.expression = child = parse(`__apm$super['${name}']`).body[0];
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
          __apm$super['${name}'] = super['${name}']
        }
      }
    `) as any
    ).body[0].body.body[0].value.body.body[0];

    node.body.body.unshift(member);
  }

  if (members.size > 0) {
    node.body.body.unshift(parse("const __apm$super = {}").body[0]);
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
      const __apm$hook = ${channelGetter}();
      if (!__apm$hook?.hasSubscribers) return __apm$traced();
      __apm$ctx.self ??= this;
      return __apm$hook.traceCallback(
        __apm$traced,
        ${callbackIndex},
        __apm$ctx
      );
    }
  `);
}

function wrapPromise(state: TransformState): AnyNode {
  const { channelName } = state;
  const channelGetter = formatChannelGetter(channelName);

  return parse(`
    function wrapper () {
      const __apm$hook = ${channelGetter}();
      if (!__apm$hook?.hasSubscribers) return __apm$traced();
      __apm$ctx.self ??= this;
      return __apm$hook.tracePromise(__apm$traced, __apm$ctx);
    }
  `);
}

function wrapSync(state: TransformState): AnyNode {
  const { channelName } = state;
  const channelGetter = formatChannelGetter(channelName);

  return parse(`
    function wrapper () {
      const __apm$hook = ${channelGetter}();
      if (!__apm$hook?.hasSubscribers) return __apm$traced();
      __apm$ctx.self ??= this;
      return __apm$hook.traceSync(__apm$traced, __apm$ctx);
    }
  `);
}
