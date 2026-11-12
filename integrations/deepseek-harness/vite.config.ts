import { defineConfig } from "vite-plus";

export default defineConfig({
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
    dts: { generator: "oxc" },
    sourcemap: true,
    fixedExtension: false,
  },
});
