import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vitest: "src/vitest.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  splitting: false,
  treeshake: true,
  // Inject the package version at build time so the cassette meta field
  // always matches the installed library version.
  define: {
    __SEINFELD_VERSION__: JSON.stringify(pkg.version),
  },
});
