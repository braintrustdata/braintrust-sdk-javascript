import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["src/**/*.test.ts"],
  },
});
