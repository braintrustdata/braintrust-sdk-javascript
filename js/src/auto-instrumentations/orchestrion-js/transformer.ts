/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import { generate } from "astring";
import esquery from "esquery";
import { parse } from "meriyah";
import { SourceMapGenerator } from "source-map";
import { wrapInvocation, type TransformState } from "./transforms";
import type {
  FunctionQuery,
  InstrumentationConfig,
  ModuleType,
  TransformOutput,
} from "./types";

type AnyNode = any;
type ExportAliases = Record<string, string>;

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
   * Instruments `code` by injecting global invocation hooks around the
   * target functions defined by this transformer's configs.
   */
  transform(code: string, moduleType: ModuleType): TransformOutput {
    if (!code || this.configs.length === 0) {
      return { code };
    }

    const options = {
      loc: true,
      ranges: true,
      raw: true,
      module: moduleType === "esm",
    };
    let ast: AnyNode;
    try {
      ast = parse(code, options);
    } catch {
      ast = parse(code, { ...options, module: !options.module });
    }
    const aliases = moduleType === "esm" ? this.collectExportAliases(ast) : {};
    let injectionCount = 0;

    for (const config of this.configs) {
      const { functionQuery } = config;

      const resolvedFunctionQuery = this.resolveExportAlias(
        functionQuery,
        aliases,
      );
      const query = this.fromFunctionQuery(resolvedFunctionQuery);
      const state: TransformState = {
        ...config,
        moduleVersion: this.version,
        functionQuery: resolvedFunctionQuery,
      };

      let functionIndex = 0;
      esquery.traverse(ast, esquery.parse(query), (node: AnyNode) => {
        injectionCount++;
        // Class matches cover instance methods installed in constructors;
        // only function matches participate in index selection.
        if (
          node.type !== "ClassDeclaration" &&
          node.type !== "ClassExpression"
        ) {
          if (node.type === "VariableDeclarator") return;
          if ((functionQuery.index ?? 0) !== functionIndex++) return;
        }
        wrapInvocation(state, node, ast);
      });
    }

    if (injectionCount === 0) {
      const names = this.configs.map(({ functionQuery }) => {
        const resolvedQuery = this.resolveExportAlias(functionQuery, aliases);
        const originalName = this.functionQueryLabel(functionQuery);
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

    const sourceMap = new SourceMapGenerator({
      file: `${this.moduleName}/${this.filePath}`,
    });
    return { code: generate(ast, { sourceMap }), map: sourceMap.toString() };
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
    if ("functionName" in functionQuery) {
      return functionQuery.functionName;
    }
    return functionQuery.propertyName;
  }

  private fromFunctionQuery(functionQuery: FunctionQuery): string {
    const queries: string[] = [];

    if ("className" in functionQuery) {
      const { className, methodName } = functionQuery;
      queries.push(
        `[id.name="${className}"]`,
        `[id.name="${className}"] > ClassExpression`,
        `[id.name="${className}"] > ClassBody > [key.name="${methodName}"][key.type=Identifier] > [async]`,
        `[id.name="${className}"] > ClassExpression > ClassBody > [key.name="${methodName}"][key.type=Identifier] > [async]`,
      );
    } else if ("methodName" in functionQuery) {
      const { methodName } = functionQuery;
      if (functionQuery.classMethods) {
        // Bundlers can rename classes while retaining their public static API.
        const shape = functionQuery.classMethods
          .map(
            (name) =>
              `:has(> MethodDefinition[static=true][key.name="${name}"])`,
          )
          .join("");
        queries.push(
          `ClassBody${shape} > MethodDefinition[static=true][key.name="${methodName}"] > FunctionExpression`,
        );
      } else {
        queries.push(
          `ClassBody > [key.name="${methodName}"][key.type=Identifier] > [async]`,
          `Property[key.name="${methodName}"][key.type=Identifier] > [async]`,
        );
      }
    }

    if ("functionName" in functionQuery) {
      const { functionName } = functionQuery;
      queries.push(`FunctionDeclaration[id.name="${functionName}"][async]`);
    }

    if ("propertyName" in functionQuery) {
      const { propertyName } = functionQuery;
      queries.push(
        `AssignmentExpression[left.object.type=ThisExpression][left.property.name="${propertyName}"] > [async]`,
      );
    }

    return queries.join(", ");
  }
}
