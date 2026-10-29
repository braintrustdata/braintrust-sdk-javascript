import { defineConfig } from "vite-plus";
import { readFileSync } from "node:fs";
import { createOtelAliases } from "./tests/utils";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __BRAINTRUST_OTEL_VERSION__: JSON.stringify(packageJson.version) },
  resolve: { alias: createOtelAliases(process.cwd()) },
  test: {
    reporters: ["default"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
  run: {
    tasks: {
      compile: {
        command: "vp pack",
        dependsOn: [
          { task: "compile", from: ["dependencies", "devDependencies"] },
        ],
        cache: {
          input: [{ auto: true }, "!dist/**"],
          untrackedEnv: ["SHELL", "BASH_ENV"],
          output: ["dist/**"],
        },
      },
    },
  },
  pack: {
    define: {
      __BRAINTRUST_OTEL_VERSION__: JSON.stringify(packageJson.version),
    },
    dts: { generator: "oxc" },
    sourcemap: true,
    fixedExtension: false,
  },
});
