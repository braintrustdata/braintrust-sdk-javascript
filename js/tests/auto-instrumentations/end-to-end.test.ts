/**
 * END-TO-END AUTO-INSTRUMENTATION TESTS
 *
 * These tests verify the COMPLETE auto-instrumentation system:
 * 1. Load the hook.mjs with --import flag
 * 2. Use REAL AI SDK packages
 * 3. Code-transformer actually transforms the SDK code
 * 4. Transformed code emits events on diagnostics_channel
 * 5. Plugins subscribe to correct channels
 * 6. Plugins create REAL spans with correct data
 *
 * This is a true end-to-end test of the entire system.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const hookPath = path.join(
  __dirname,
  "../../dist/auto-instrumentations/hook.mjs",
);

/**
 * Run a test script with the auto-instrumentation hook loaded.
 * Returns the spans that were created.
 */
async function runWithAutoInstrumentation(
  scriptPath: string,
  env: Record<string, string> = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  spans: any[];
}> {
  return new Promise((resolve, reject) => {
    const hookUrl = pathToFileURL(hookPath).href;
    const child = spawn(process.execPath, [`--import=${hookUrl}`, scriptPath], {
      env: {
        ...process.env,
        ...env,
        // Disable actual API calls
        NODE_ENV: "test",
      },
      cwd: fixturesDir,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      // Extract spans from output
      const spans: any[] = [];
      const spanMatches = stdout.matchAll(/SPAN_DATA: (.+)/g);
      for (const match of spanMatches) {
        try {
          spans.push(JSON.parse(match[1]));
        } catch (e) {
          // Ignore parse errors
        }
      }

      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
        spans,
      });
    });

    child.on("error", reject);
  });
}

describe("End-to-End Auto-Instrumentation", () => {
  beforeAll(() => {
    // Ensure hook is built
    if (!fs.existsSync(hookPath)) {
      throw new Error(`Hook not found at ${hookPath}. Run 'pnpm build' first.`);
    }
  });

  describe("Anthropic SDK", () => {
    it("should instrument Anthropic messages.create and create spans", async () => {
      const testScript = path.join(fixturesDir, "anthropic-e2e-test.mjs");

      const result = await runWithAutoInstrumentation(testScript);

      // Verify script succeeded
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SUCCESS");

      // Verify spans were created
      expect(result.spans.length).toBeGreaterThan(0);

      const span = result.spans[0];

      // Verify span name (critical - proves correct channel name)
      expect(span.span_attributes?.name).toBe("anthropic.messages.create");

      // Verify span has input
      expect(span.input).toBeDefined();
      expect(Array.isArray(span.input)).toBe(true);

      // Verify span has output
      expect(span.output).toBeDefined();

      // Verify span has metrics
      expect(span.metrics).toBeDefined();
      expect(span.metrics.prompt_tokens).toBe(10);
      expect(span.metrics.completion_tokens).toBe(5);
    }, 30000); // 30s timeout for real SDK loading

    it("should use correct channel name orchestrion:@anthropic-ai/sdk:messages.create", async () => {
      const testScript = path.join(
        fixturesDir,
        "anthropic-channel-name-test.mjs",
      );

      const result = await runWithAutoInstrumentation(testScript);

      // Verify channel event was received
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CHANNEL_EVENT_RECEIVED: true");
      expect(result.stdout).toContain("SUCCESS");
    }, 30000);
  });

  describe("OpenAI SDK", () => {
    it("should instrument OpenAI chat.completions.create and create spans", async () => {
      const testScript = path.join(fixturesDir, "openai-e2e-test.mjs");

      const result = await runWithAutoInstrumentation(testScript);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SUCCESS");
      expect(result.spans.length).toBeGreaterThan(0);

      const span = result.spans[0];
      expect(span.span_attributes?.name).toBe("Chat Completion");
      expect(span.metrics?.prompt_tokens).toBe(10);
      expect(span.metrics?.completion_tokens).toBe(5);
    }, 30000);
  });

  describe("Channel Name Validation", () => {
    it("should fail if plugin subscribes to wrong channel name", async () => {
      const testScript = path.join(fixturesDir, "wrong-channel-test.mjs");

      const result = await runWithAutoInstrumentation(testScript);

      // Should succeed - the event should NOT be received on wrong channel
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SUCCESS");
    }, 30000);
  });
});
