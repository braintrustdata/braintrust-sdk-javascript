import { register } from "node:module";

// Simulate another tool's module.register() loader alongside Braintrust.
register("./async-loader.mjs", import.meta.url);
