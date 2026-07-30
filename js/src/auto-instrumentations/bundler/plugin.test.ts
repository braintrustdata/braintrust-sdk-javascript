import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { unplugin } from "./plugin";

const require = createRequire(import.meta.url);

describe("bundler instrumentation plugin", () => {
  it("matches dependency paths with Vite cache queries", async () => {
    const rawPlugin = unplugin.raw(
      {
        instrumentations: [
          {
            channelName: "querySuffixProbe",
            functionQuery: {
              functionName: "querySuffixProbe",
              kind: "Async",
            },
            module: {
              filePath: "dist/index.js",
              name: "ai",
              versionRange: ">=6 <7",
            },
          },
        ],
      },
      { framework: "vite" },
    );
    const plugin = Array.isArray(rawPlugin) ? rawPlugin[0] : rawPlugin;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string } | null> | { code: string } | null;
    const result = await transform(
      "export async function querySuffixProbe() { return 1; }",
      `${require.resolve("ai")}?v=01234567`,
    );

    expect(result?.code).toContain("orchestrion:ai:querySuffixProbe");
  });
});
