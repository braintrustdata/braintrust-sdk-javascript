import { newId, Prompt } from "./logger";
import {
  type FunctionIdType as FunctionId,
  type GraphDataType as GraphData,
  type GraphNodeType as GraphNode,
  type GraphEdgeType as GraphEdge,
  type PromptBlockDataType as PromptBlockData,
} from "./generated_plain_types";

export interface BuildContext {
  getFunctionId(functionObj: unknown): Promise<FunctionId>;
}

// Base interface for all node types
export interface Node {
  readonly id: string;
  __type: "node";
  build(context: BuildContext): Promise<GraphNode>;
  addDependency(dependency: Dependency): void;
}

// type CallArgs = ProxyVariable | Node | Record<string, ProxyVariable | Node>;

export type NodeLike = Node | Prompt<boolean, boolean> | ProxyVariable;

export type LazyGraphNode = {
  type: "lazy";
  id: string;
};

// Graph builder class to convert functional chains to GraphData
export class GraphBuilder {
  private nodes = new Map<string, Node>();
  private edges: Record<string, GraphEdge> = {};

  private nodeLikeNodes = new Map<unknown, Node>(); // Maps node-like objects, like prompts, to their nodes

  // Special nodes
  public readonly IN: InputNode;
  public readonly OUT: OutputNode;

  constructor() {
    // Create input and output nodes
    this.IN = this.createInputNode();
    this.OUT = this.createOutputNode();
  }

  // Create the final GraphData object
  public async build(context: BuildContext): Promise<GraphData> {
    const nodes = await Promise.all(
      Array.from(this.nodes.values()).map(async (node) => [
        node.id,
        await node.build(context),
      ]),
    );

    return {
      type: "graph",
      nodes: Object.fromEntries(nodes), // XXX Need to resolve the lazy nodes
      edges: this.edges,
    };
  }

  public addEdge({
    source,
    sourceVar,
    target,
    targetVar,
    expr,
    purpose,
  }: {
    source: NodeLike;
    sourceVar?: string;
    target: NodeLike;
    targetVar?: string;
    expr?: string;
    purpose: GraphEdge["purpose"];
  }) {
    const [sourceNode, sourcePath] = this.resolveNode(source);
    if (sourcePath.length > 0) {
      // XXX Maybe we can remove these paths?
      throw new Error("Source path must be empty");
    }
    const [targetNode, targetPath] = this.resolveNode(target);
    if (targetPath.length > 0) {
      throw new Error("Target path must be empty");
    }
    const id = this.generateId();

    sourceVar = sourceVar ?? "output";
    targetVar =
      targetVar ?? (purpose === "data" ? "input" : this.generateId("control"));

    // Make sure this variable name doesn't already exist as a target variable
    for (const edge of Object.values(this.edges)) {
      if (
        edge.target.node === targetNode.id &&
        edge.target.variable === targetVar
      ) {
        throw new Error(
          `Variable name ${targetVar} already set on ${targetNode.id}`,
        );
      }
    }

    this.edges[id] = {
      source: { node: sourceNode.id, variable: sourceVar },
      target: { node: targetNode.id, variable: targetVar },
      purpose,
    };
  }

  public resolveNode(node: NodeLike): [Node, string[]] {
    if (node instanceof Prompt) {
      const cached = this.nodeLikeNodes.get(node);
      if (cached) {
        return [cached, []];
      }
      const promptNode = this.createPromptNode(node);
      this.nodeLikeNodes.set(node, promptNode);
      return [promptNode, []];
    } else if (isProxyVariable(node)) {
      return proxyVariableToNode(node);
    } else {
      return [node, []];
    }
  }

  // Create a literal node
  public literal<T>(value: T): LiteralNode<T> {
    const preview = (
      typeof value === "string" ? value : JSON.stringify(value)
    ).slice(0, 16);
    const id = this.generateId(`literal-${preview}`);
    const literalNode = new LiteralNode<T>(this, id, value);
    this.nodes.set(id, literalNode);
    return literalNode;
  }

  public gate(options: { condition: string }): GateNode {
    const id = this.generateId("gate");
    const gateNode = new GateNode(this, id, options.condition);
    this.nodes.set(id, gateNode);
    return gateNode;
  }

  public aggregator(): AggregatorNode {
    const id = this.generateId("aggregator");
    const aggregatorNode = new AggregatorNode(this, id);
    this.nodes.set(id, aggregatorNode);
    return aggregatorNode;
  }

  public promptTemplate(options: {
    prompt: PromptBlockData;
  }): PromptTemplateNode {
    const id = this.generateId("prompt-template");
    const promptTemplateNode = new PromptTemplateNode(this, id, options.prompt);
    this.nodes.set(id, promptTemplateNode);
    return promptTemplateNode;
  }

  // public call(node: NodeLike, input: CallArgs): Node {
  //   const [resolvedNode, path] = this.resolveNode(node);
  //   if (resolvedNode instanceof SingleInputNode) {
  //     return resolvedNode.call(input, path);
  //   } else {
  //     throw new Error("Node must be a SingleInputNode");
  //   }
  // }

  // Helper to generate node IDs
  private generateId(name?: string): string {
    const uuid = newId();
    if (name) {
      return `${name}-${uuid.slice(0, 8)}`;
    } else {
      return uuid;
    }
  }

  // Create an input node
  private createInputNode(): InputNode {
    const id = this.generateId("input");
    const inputNode = new InputNode(this, id);
    this.nodes.set(id, inputNode);
    return inputNode;
  }

  // Create an output node
  private createOutputNode(): OutputNode {
    const id = this.generateId("output");
    const outputNode = new OutputNode(this, id);
    this.nodes.set(id, outputNode);
    return outputNode;
  }

  // Create a prompt node from a CodePrompt
  private createPromptNode(prompt: Prompt): PromptNode {
    const id = this.generateId(`prompt-${prompt.slug}`);

    const promptNode = new PromptNode(this, id, prompt);
    this.nodes.set(id, promptNode);
    return promptNode;
  }
}

export type ProxyVariable = {
  [key: string]: ProxyVariable;
};

function isProxyVariable(node: unknown): node is ProxyVariable {
  return (
    typeof node === "object" &&
    node !== null &&
    "__type" in node &&
    // @ts-ignore
    node.__type === "proxy-variable"
  );
}

function proxyVariableToNode(proxy: ProxyVariable): [Node, string[]] {
  // @ts-ignore
  return [proxy.__node, proxy.__path];
}

// // Create a proxy handler that captures property access paths
// function createVariableProxy({
//   path,
//   node,
// }: {
//   path: string[];
//   node: Node;
// }): ProxyVariable {
//   // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
//   return new Proxy({} as ProxyVariable, {
//     get(target, prop) {
//       if (typeof prop === "string") {
//         if (prop === "__type") {
//           return "proxy-variable";
//         } else if (prop === "__node") {
//           return node;
//         } else if (prop === "__path") {
//           return path;
//         }

//         const newPath = [...path, prop];

//         // Return a variable reference for terminal properties
//         // or a new proxy for further chaining
//         return createVariableProxy({ path: newPath, node });
//       }
//       return undefined;
//     },
//     has(target, prop) {
//       return typeof prop === "string";
//     },
//   });
// }

// Type for transform functions
export type TransformFn = (input: ProxyVariable) => Node;

interface Dependency {
  node: Node;
  sourceVar?: string;
  targetVar?: string;
  expr?: string;
}

// Base Node class for common functionality
abstract class BaseNode implements Node {
  public readonly __type = "node";
  public dependencies: Dependency[] = [];

  constructor(
    protected graph: GraphBuilder,
    public readonly id: string,
  ) {}

  public addDependency(dependency: Dependency) {
    this.dependencies.push(dependency);
  }

  abstract build(context: BuildContext): Promise<GraphNode>;
}

// abstract class SingleOutputNode extends BaseNode {
//   // Connect this node to another node
//   public then(...args: Array<NodeLike | TransformFn>): Node {
//     // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
//     const callableThis = this as unknown as Node;
//     let lastNode: Node = callableThis;

//     // Connect each arg to this node
//     for (const arg of args) {
//       // Handle different types of arguments
//       if (typeof arg === "function") {
//         // This function is expected to take dependencies as needed on the argsProxy.
//         const argsProxy = createVariableProxy({ path: [], node: callableThis });
//         const result = arg(argsProxy);
//         lastNode = result;
//       } else {
//         const [node, path] = this.graph.resolveNode(arg);
//         lastNode = node;
//         node.addDependency({ node: callableThis, expr: escapePath(path) });
//       }
//     }

//     return lastNode;
//   }
// }

// abstract class SingleInputNode extends BaseNode {
//   public call(input: CallArgs, path?: string[]): Node {
//     if (isProxyVariable(input)) {
//       const [sourceNode, sourcePath] = proxyVariableToNode(input);
//       this.addDependency({ node: sourceNode, expr: escapePath(sourcePath) });
//     } else if (isNode(input)) {
//       this.addDependency({
//         node: input,
//         expr: path ? escapePath(path) : undefined,
//       });
//     } else {
//       for (const [targetVar, source] of Object.entries(input)) {
//         const [sourceNode, sourcePath] = this.graph.resolveNode(source);
//         this.addDependency({
//           node: sourceNode,
//           expr: sourcePath ? escapePath(sourcePath) : undefined,
//           targetVar,
//         });
//       }
//     }
//     return this;
//   }
// }

// function isNode(node: unknown): node is Node {
//   return (
//     typeof node === "object" &&
//     node !== null &&
//     "__type" in node &&
//     // @ts-ignore
//     node.__type === "node"
//   );
// }

// Input node (entry point to the graph)
export class InputNode extends BaseNode implements Node {
  constructor(graph: GraphBuilder, id: string) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "input",
      description: "Input to the graph",
    };
  }
}

// Output node (exit point from the graph)
export class OutputNode extends BaseNode implements Node {
  constructor(graph: GraphBuilder, id: string) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "output",
      description: "Output of the graph",
    };
  }
}

// Prompt node (wrapper for CodePrompt)
export class PromptNode extends BaseNode implements Node {
  constructor(
    graph: GraphBuilder,
    id: string,
    private prompt: Prompt,
  ) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "function",
      function: await context.getFunctionId(this.prompt),
    };
  }
}

// Gate node for conditional branching
export class GateNode extends BaseNode implements Node {
  constructor(
    graph: GraphBuilder,
    id: string,
    private condition: string,
  ) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "gate",
      description: "Conditional gate",
      condition: this.condition,
    };
  }
}

export class AggregatorNode extends BaseNode implements Node {
  constructor(graph: GraphBuilder, id: string) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "aggregator",
      description: "Aggregator",
    };
  }
}

export class PromptTemplateNode extends BaseNode implements Node {
  constructor(
    graph: GraphBuilder,
    id: string,
    private prompt: PromptBlockData,
  ) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "prompt_template",
      prompt: this.prompt,
    };
  }
}

// Literal node for constant values
export class LiteralNode<T> extends BaseNode implements Node {
  constructor(
    graph: GraphBuilder,
    id: string,
    private value: T,
  ) {
    super(graph, id);
  }

  public async build(context: BuildContext): Promise<GraphNode> {
    return {
      type: "literal",
      value: this.value,
    };
  }
}

// Create a graph instance with IN and OUT nodes
export function createGraph(): GraphBuilder {
  const graphBuilder = new GraphBuilder();
  return graphBuilder;
}

// XXX write tests
export function escapePath(parts: string[]): string | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  return parts
    .map((part) => {
      if (/[^\w-]/.test(part)) {
        // Escape special characters properly
        const escaped = part.replace(/["\\]/g, "\\$&");
        return `"${escaped}"`;
      }
      return part;
    })
    .join(".");
}

export function unescapePath(path: string): string[] {
  const regex = /"((?:\\["\\]|[^"\\])*)"|([^\.]+)/g;
  const matches = path.match(regex);
  return matches
    ? matches.map((match) => {
        if (match.startsWith('"')) {
          // Remove surrounding quotes and unescape special characters
          return match.slice(1, -1).replace(/\\(["\\])/g, "$1");
        }
        return match;
      })
    : [];
}

// Export the graph constructor
export default { createGraph };
