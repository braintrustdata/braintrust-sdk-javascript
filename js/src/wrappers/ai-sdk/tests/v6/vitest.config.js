import path from "path";

const config = {
  resolve: {
    // Prioritize local node_modules for ai, @ai-sdk, and zod packages (v6 specific)
    alias: {
      ai: path.resolve(__dirname, "node_modules/ai"),
      "@ai-sdk/openai": path.resolve(__dirname, "node_modules/@ai-sdk/openai"),
      "@ai-sdk/anthropic": path.resolve(
        __dirname,
        "node_modules/@ai-sdk/anthropic",
      ),
      zod: path.resolve(__dirname, "node_modules/zod"),
    },
  },
  test: {
    reporters: ["default"],
    include: ["../../ai-sdk.test.ts", "./ai-sdk.v6.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
export default config;
