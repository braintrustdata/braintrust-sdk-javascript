import { createRequire } from "node:module";
import { describe, expect, it } from "vite-plus/test";
import { unplugin } from "./plugin";

const require = createRequire(import.meta.url);

describe("bundler instrumentation plugin", () => {
  it("matches dependency paths with Vite cache queries", async () => {
    const rawPlugin = unplugin.raw({}, { framework: "vite" });
    const plugin = Array.isArray(rawPlugin) ? rawPlugin[0] : rawPlugin;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string } | null> | { code: string } | null;
    const result = await transform(
      "export async function generateText() { return 1; }",
      `${require.resolve("ai")}?v=01234567`,
    );

    expect(result?.code).toContain("orchestrion:ai:generateText");
  });
});
