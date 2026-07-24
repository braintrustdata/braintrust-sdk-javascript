/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import esquery from "esquery";
import { generate } from "astring";
import { parse } from "meriyah";
import { SourceMapGenerator } from "source-map";
import { transforms, type TransformState } from "./transforms";
import type {
  FunctionKind,
  FunctionQuery,
  InstrumentationConfig,
  ModuleType,
  TransformOutput,
} from "./types";

type AnyNode = any;
type ExportAliases = Record<string, string>;
type TraceOperator = "traceCallback" | "tracePromise" | "traceSync";

/**
 * Applies instrumentation configs to JavaScript source by parsing it into an
 * AST, locating target functions, injecting global instrumentation hooks
 * wrappers, and regenerating the source.
 */
export class Transformer {
  private moduleName: string;
  private version: string;
  private filePath: string;
  private configs: InstrumentationConfig[] = [];

  constructor(
    moduleName: string,
    version: string,
    filePath: string,
    configs: InstrumentationConfig[],
  ) {
    this.moduleName = moduleName;
    this.version = version;
    this.filePath = filePath;
    this.configs = configs;
  }

  /**
   * Instruments `code` by injecting global tracing hooks around the
   * target functions defined by this transformer's configs.
   */
  transform(code: string | Buffer, moduleType: ModuleType): TransformOutput {
    if (Buffer.isBuffer(code)) {
      code = code.toString();
    }
    if (!code) {
      return { code };
    }

    let ast: AnyNode | undefined;
    let aliases: ExportAliases = {};
    let injectionCount = 0;

    for (const config of this.configs) {
      const { astQuery, functionQuery } = config;

      if (!ast) {
        const options = {
          loc: true,
          ranges: true,
          raw: true,
          module: moduleType === "esm",
        };

        try {
          ast = parse(code, options as any);
        } catch {
          ast = parse(code, { ...options, module: !options.module } as any);
        }

        if (moduleType === "esm") {
          aliases = this.collectExportAliases(ast);
        }
      }

      const resolvedFunctionQuery = this.resolveExportAlias(
        functionQuery,
        aliases,
      );
      const query = astQuery || this.fromFunctionQuery(resolvedFunctionQuery);
      const state: TransformState = {
        ...config,
        moduleType,
        moduleVersion: this.version,
        functionQuery: resolvedFunctionQuery,
        operator: this.getOperator(resolvedFunctionQuery.kind),
      };

      esquery.traverse(ast, esquery.parse(query), (...args: any[]) => {
        injectionCount++;
        this.visit(state, ...args);
      });
    }

    if (injectionCount === 0 && this.configs.length > 0) {
      const names = this.configs.map(({ astQuery, functionQuery }) => {
        const resolvedQuery = this.resolveExportAlias(functionQuery, aliases);
        const queryName = (q: any) =>
          q.methodName ||
          q.privateMethodName ||
          q.functionName ||
          q.propertyName ||
          astQuery ||
          "unknown";
        const originalName = queryName(functionQuery);
        const originalAlias =
          (functionQuery as any).className ||
          (functionQuery as any).functionName;
        const resolvedAlias =
          (resolvedQuery as any).className ||
          (resolvedQuery as any).functionName;
        if (originalAlias && originalAlias !== resolvedAlias) {
          return `${originalAlias} (local name: ${resolvedAlias})`;
        }
        return originalName;
      });
      throw new Error(
        `Failed to find injection points for: ${JSON.stringify(names)}`,
      );
    }

    if (ast) {
      const file = `${this.moduleName}/${this.filePath}`;
      const sourceMap = new SourceMapGenerator({ file });
      const transformedCode = generate(ast, { sourceMap });
      const map = sourceMap.toString();

      return { code: transformedCode, map };
    }

    return { code };
  }

  free(): void {}

  private visit(state: TransformState, ...args: any[]): void {
    const transform = transforms[state.operator];
    const { index = 0 } = state.functionQuery as any;
    const [node] = args;
    const type = node.init?.type || node.type;

    // Class nodes are visited for traceInstanceMethod, but index matching only
    // counts function nodes.
    if (type !== "ClassDeclaration" && type !== "ClassExpression") {
      if (node.type === "VariableDeclarator") {
        return;
      }

      state.functionIndex =
        state.functionIndex === undefined ? 0 : state.functionIndex + 1;

      if (index !== null && index !== state.functionIndex) {
        return;
      }
    }

    (transform as (...args: any[]) => void)(state, ...args);
  }

  private getOperator(kind: FunctionKind): TraceOperator {
    switch (kind) {
      case "Async":
        return "tracePromise";
      case "Callback":
        return "traceCallback";
      case "Sync":
        return "traceSync";
    }
  }

  private collectExportAliases(ast: AnyNode): ExportAliases {
    const aliases: ExportAliases = {};
    for (const node of ast.body) {
      if (node.type === "ExportNamedDeclaration" && !node.source) {
        for (const spec of node.specifiers) {
          if (spec.exported && spec.local) {
            const exportedName = spec.exported.name ?? spec.exported.value;
            const localName = spec.local.name ?? spec.local.value;
            if (exportedName && localName) {
              aliases[exportedName] = localName;
            }
          }
        }
      }
    }
    return aliases;
  }

  private resolveExportAlias(
    functionQuery: FunctionQuery,
    aliases: ExportAliases,
  ): FunctionQuery {
    if (!("isExportAlias" in functionQuery) || !functionQuery.isExportAlias) {
      return functionQuery;
    }
    if ("className" in functionQuery && aliases[functionQuery.className]) {
      return {
        ...functionQuery,
        className: aliases[functionQuery.className],
      };
    }
    if (
      "functionName" in functionQuery &&
      aliases[functionQuery.functionName]
    ) {
      return {
        ...functionQuery,
        functionName: aliases[functionQuery.functionName],
      };
    }
    return functionQuery;
  }

  private functionQueryLabel(functionQuery: FunctionQuery): string {
    if ("methodName" in functionQuery) {
      return functionQuery.methodName;
    }
    if ("privateMethodName" in functionQuery) {
      return functionQuery.privateMethodName;
    }
    if ("functionName" in functionQuery) {
      return functionQuery.functionName;
    }
    if ("propertyName" in functionQuery) {
      return functionQuery.propertyName;
    }
    return "unknown";
  }

  private fromFunctionQuery(functionQuery: FunctionQuery): string {
    const queries: string[] = [];

    if ("className" in functionQuery) {
      const { className } = functionQuery;
      const methodName = this.functionQueryLabel(functionQuery);
      const keyType =
        "privateMethodName" in functionQuery
          ? "PrivateIdentifier"
          : "Identifier";
      queries.push(
        `[id.name="${className}"]`,
        `[id.name="${className}"] > ClassExpression`,
        `[id.name="${className}"] > ClassBody > [key.name="${methodName}"][key.type=${keyType}] > [async]`,
        `[id.name="${className}"] > ClassExpression > ClassBody > [key.name="${methodName}"][key.type=${keyType}] > [async]`,
      );
    } else if ("methodName" in functionQuery) {
      const { methodName } = functionQuery;
      queries.push(
        `ClassBody > [key.name="${methodName}"][key.type=Identifier] > [async]`,
        `Property[key.name="${methodName}"][key.type=Identifier] > [async]`,
      );
    }

    if ("functionName" in functionQuery) {
      const { functionName } = functionQuery;
      queries.push(`FunctionDeclaration[id.name="${functionName}"][async]`);
    }

    if ("objectName" in functionQuery) {
      const { objectName, propertyName } = functionQuery;
      const objectSelector =
        objectName === "this"
          ? "left.object.type=ThisExpression"
          : `left.object.name="${objectName}"`;
      queries.push(
        `AssignmentExpression[${objectSelector}][left.property.name="${propertyName}"] > [async]`,
      );
    }

    return queries.join(", ");
  }
}
