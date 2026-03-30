import type { NextConfig } from "next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      // Apply the loader to all JS/MJS/CJS files from node_modules.
      // condition: "foreign" restricts the rule to third-party packages only.
      "*.{js,mjs,cjs}": {
        condition: "foreign",
        loaders: [{ loader: require.resolve("braintrust/webpack-loader") }],
      },
    },
  },
};

export default nextConfig;
