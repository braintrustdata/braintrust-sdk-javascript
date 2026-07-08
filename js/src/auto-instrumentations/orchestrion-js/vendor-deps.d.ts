/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

declare module "semifies" {
  function semifies(version: string, range: string): boolean;
  export = semifies;
}
