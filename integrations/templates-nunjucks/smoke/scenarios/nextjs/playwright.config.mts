import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  webServer: {
    command: "pnpm exec next dev --port 3456",
    port: 3456,
    cwd: __dirname,
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:3456",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
