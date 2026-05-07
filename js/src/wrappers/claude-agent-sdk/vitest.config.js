import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

const config = {
  plugins: [
    tsconfigPaths({
      // Only use the local tsconfig, don't scan for others
      root: __dirname,
      projects: [path.resolve(__dirname, "tsconfig.json")],
      // Ignore tsconfig files in these directories
      ignoreConfigErrors: true,
    }),
  ],
  resolve: {
    extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx", ".json"],
    alias: {
      // Prevent resolution into vendor directories
      vendor: false,
    },
  },
  server: {
    fs: {
      // Deny access to vendor folder
      deny: [path.resolve(__dirname, "../../../vendor"), "**/vendor/**"],
    },
  },
  optimizeDeps: {
    exclude: ["vendor/**", "**/vendor/**"],
  },
  test: {
    reporters: ["default"],
    exclude: [
      // Default vitest exclusions
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      // Exclude vendor folder and all its contents
      "**/vendor/**",
      "../../../vendor/**",
    ],
    watchExclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/vendor/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
  },
};
export default config;
