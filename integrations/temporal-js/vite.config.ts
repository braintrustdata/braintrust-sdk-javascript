import { defineConfig } from "vite-plus";

export default defineConfig({
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
    entry: ["src/index.ts", "src/workflow-interceptors.ts"],
    deps: { neverBundle: ["@braintrust/temporal/workflow-interceptors"] },
    dts: { generator: "oxc" },
    sourcemap: true,
    fixedExtension: false,
  },
});
