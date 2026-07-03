/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

declare module "esquery" {
  const esquery: {
    parse(selector: string): unknown;
    traverse(
      ast: unknown,
      selector: unknown,
      visitor: (node: any, parent: any, ancestry: any[]) => void,
    ): void;
    query(ast: unknown, selector: string): any[];
  };
  export = esquery;
}

declare module "semifies" {
  function semifies(version: string, range: string): boolean;
  export = semifies;
}
