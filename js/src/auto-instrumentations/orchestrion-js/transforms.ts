/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import esquery from "esquery";
import { parse } from "meriyah";
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
  dcModule: string;
  moduleType: ModuleType;
  moduleVersion: string;
  functionQuery: FunctionQuery;
  operator: TraceOperator;
  functionIndex?: number;
}

const tracingChannelPredicate = (node: AnyNode): boolean =>
  node.declarations?.[0]?.id?.properties?.[0]?.value?.name ===
  "tr_ch_apm_tracingChannel";

const CHANNEL_REGEX = /[^\w]/g;

function formatChannelVariable(channelName: string): string {
  return `tr_ch_apm$${channelName.replace(CHANNEL_REGEX, "_")}`;
}

export const transforms: Record<string, TransformFn> = {
  tracingChannelImport({ dcModule, moduleType }, node) {
    if (node.body.some(tracingChannelPredicate)) {
      return;
    }

    const options = { module: moduleType === "esm" };
    const index = node.body.findIndex(
      (child: AnyNode) => child.directive === "use strict",
    );
    const dc =
      moduleType === "esm"
        ? `import tr_ch_apm_dc from "${dcModule}"`
        : `const tr_ch_apm_dc = ${"require"}("${dcModule}")`;
    const tracingChannel =
      "const { tracingChannel: tr_ch_apm_tracingChannel } = tr_ch_apm_dc";
    const hasSubscribers = `const tr_ch_apm_hasSubscribers = ch => ch.start.hasSubscribers
      || ch.end.hasSubscribers
      || ch.asyncStart.hasSubscribers
      || ch.asyncEnd.hasSubscribers
      || ch.error.hasSubscribers`;

    node.body.splice(
      index + 1,
      0,
      parse(dc, options as any).body[0],
      parse(tracingChannel, options as any).body[0],
      parse(hasSubscribers, options as any).body[0],
    );
  },

  tracingChannelDeclaration(state, node) {
    const {
      channelName,
      module: { name },
    } = state;
    const channelVariable = formatChannelVariable(channelName);

    if (
      node.body.some(
        (child: AnyNode) =>
          child.declarations?.[0]?.id?.name === channelVariable,
      )
    ) {
      return;
    }

    transforms.tracingChannelImport(state, node, null, []);

    const index = node.body.findIndex(tracingChannelPredicate);
    const code = `
      const ${channelVariable} = tr_ch_apm_tracingChannel("orchestrion:${name}:${channelName}")
    `;

    node.body.splice(index + 1, 0, parse(code).body[0]);
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
  transforms.tracingChannelDeclaration(state, program, null, []);

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

  transforms.tracingChannelDeclaration(state, program, null, []);

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

  esquery.query(block, "[id.name=__apm$wrapped]")[0].init = node;

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
  const channelVariable = formatChannelVariable(channelName);

  return parse(`
    function wrapper () {
      const __apm$cb = Array.prototype.at.call(arguments, ${callbackIndex});

      if (!${channelVariable}.start.hasSubscribers) return __apm$traced();

      function __apm$wrappedCb(err, res) {
        if (err) {
          __apm$ctx.error = err;
          ${channelVariable}.error.publish(__apm$ctx);
        } else {
          __apm$ctx.result = res;
        }

        ${channelVariable}.asyncStart.runStores(__apm$ctx, () => {
          try {
            if (__apm$cb) {
              return __apm$cb.apply(this, arguments);
            }
          } finally {
            ${channelVariable}.asyncEnd.publish(__apm$ctx);
          }
        });
      }

      if (typeof __apm$cb !== 'function') {
        return __apm$traced();
      }
      Array.prototype.splice.call(arguments, ${callbackIndex}, 1, __apm$wrappedCb);

      return ${channelVariable}.start.runStores(__apm$ctx, () => {
        try {
          return __apm$traced();
        } catch (err) {
          __apm$ctx.error = err;
          ${channelVariable}.error.publish(__apm$ctx);
          throw err;
        } finally {
          __apm$ctx.self ??= this;
          ${channelVariable}.end.publish(__apm$ctx);
        }
      });
    }
  `);
}

function wrapPromise(state: TransformState): AnyNode {
  const { channelName } = state;
  const channelVariable = formatChannelVariable(channelName);

  return parse(`
    function wrapper () {
      if (!tr_ch_apm_hasSubscribers(${channelVariable})) return __apm$traced();

      return ${channelVariable}.start.runStores(__apm$ctx, () => {
        try {
          let promise = __apm$traced();
          if (typeof promise?.then !== 'function') {
            __apm$ctx.result = promise;
            return promise;
          }
          // Mirror Node.js core diagnostics_channel behaviour: for native Promise
          // instances, chain normally (safe since there is no subclass API to
          // preserve). For Promise subclasses and other thenables, side-chain the
          // callbacks for event publishing and return the original so that any
          // subclass-specific methods (e.g. APIPromise.withResponse()) remain
          // accessible to the caller.
          if (promise instanceof Promise && promise.constructor === Promise) {
            return promise.then(
              result => {
                __apm$ctx.result = result;
                ${channelVariable}.asyncStart.publish(__apm$ctx);
                ${channelVariable}.asyncEnd.publish(__apm$ctx);
                return result;
              },
              err => {
                __apm$ctx.error = err;
                ${channelVariable}.error.publish(__apm$ctx);
                ${channelVariable}.asyncStart.publish(__apm$ctx);
                ${channelVariable}.asyncEnd.publish(__apm$ctx);
                throw err;
              }
            );
          }
          promise.then(
            result => {
              __apm$ctx.result = result;
              ${channelVariable}.asyncStart.publish(__apm$ctx);
              ${channelVariable}.asyncEnd.publish(__apm$ctx);
            },
            err => {
              __apm$ctx.error = err;
              ${channelVariable}.error.publish(__apm$ctx);
              ${channelVariable}.asyncStart.publish(__apm$ctx);
              ${channelVariable}.asyncEnd.publish(__apm$ctx);
            }
          );
          return promise;
        } catch (err) {
          __apm$ctx.error = err;
          ${channelVariable}.error.publish(__apm$ctx);
          throw err;
        } finally {
          __apm$ctx.self ??= this;
          ${channelVariable}.end.publish(__apm$ctx);
        }
      });
    }
  `);
}

function wrapSync(state: TransformState): AnyNode {
  const { channelName } = state;
  const channelVariable = formatChannelVariable(channelName);

  return parse(`
    function wrapper () {
      if (!tr_ch_apm_hasSubscribers(${channelVariable})) return __apm$traced();

      return ${channelVariable}.start.runStores(__apm$ctx, () => {
        try {
          const result = __apm$traced();
          __apm$ctx.result = result;
          return result;
        } catch (err) {
          __apm$ctx.error = err;
          ${channelVariable}.error.publish(__apm$ctx);
          throw err;
        } finally {
         __apm$ctx.self ??= this;
          ${channelVariable}.end.publish(__apm$ctx);
        }
      });
    }
  `);
}
