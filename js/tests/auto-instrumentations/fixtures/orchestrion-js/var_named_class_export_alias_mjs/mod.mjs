/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
class Base {
  async fetch(url) {
    return 0;
  }
}

const J = class InternalName extends Base {
  async fetch(url) {
    return 42;
  }
};

export { J as Undici };
