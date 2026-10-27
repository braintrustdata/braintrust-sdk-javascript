import module from "node:module";

// Exercise the fallback on modern Node.js without a production-only flag.
module.registerHooks = undefined;
module.syncBuiltinESMExports();
