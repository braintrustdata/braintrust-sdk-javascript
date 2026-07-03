/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
const Server = (() => {
  class Server {
    constructor() {
      this.id = 1;
    }

    register() {
      return 1;
    }
  }
  return Server;
})();

exports.Server = Server;
