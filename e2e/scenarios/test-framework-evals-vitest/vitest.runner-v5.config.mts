const vitestConfigPackageName =
  process.env.VITEST_CONFIG_PACKAGE_NAME ?? "vitest-v5-latest";
const { defineConfig } = await import(`${vitestConfigPackageName}/config`);

export default defineConfig({
  test: {
    clearMocks: false,
    sharedViteServer: false,
    hookTimeout: 30_000,
    include: ["runner.case.ts"],
    testTimeout: 20_000,
  },
});
