import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: retain until the complete Harness Docker matrix
    // can validate both changes. Local replay passes without clearMocks, but the
    // remote Docker host cannot reach this workspace's cassette server.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    clearMocks: false,
    sharedViteServer: false,
    reporters: ["default"],
    include: ["scenarios/**/*.test.ts", "helpers/**/*.test.ts"],
    // We run the scenarios in the hooks.
    hookTimeout: 120_000,
    testTimeout: 20_000,
    // 120 seconds - our testsuite is inherently slow because of LLMs and if a
    // test is slower than the threshold (default 300ms) it will not show up in
    // the reporter output.
    slowTestThreshold: 120_000,
    // Default to one retry for provider/network flake.
    retry: 1,
    // Allow up to 5 describe blocks to run their beforeAll hooks concurrently
    // within a file. Bounded to avoid overwhelming CI with too many subprocesses
    // at once. Tune down if CI shows memory pressure or flaky timeouts.
    maxConcurrency: 5,
    setupFiles: ["./vitest.setup.ts"],
  },
});
