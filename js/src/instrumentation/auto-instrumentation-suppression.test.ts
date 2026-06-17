import { beforeAll, describe, expect, it } from "vitest";
import { configureNode } from "../node/config";
import {
  enterAutoInstrumentationAllowed,
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "./auto-instrumentation-suppression";

describe("auto instrumentation suppression context", () => {
  beforeAll(() => {
    configureNode();
  });

  it("suppresses auto instrumentation until a Pi tool context allows it", async () => {
    expect(isAutoInstrumentationSuppressed()).toBe(false);

    await runWithAutoInstrumentationSuppressed(async () => {
      expect(isAutoInstrumentationSuppressed()).toBe(true);
      await Promise.resolve();
      expect(isAutoInstrumentationSuppressed()).toBe(true);

      const restoreToolContext = enterAutoInstrumentationAllowed();
      expect(isAutoInstrumentationSuppressed()).toBe(false);

      await runWithAutoInstrumentationSuppressed(async () => {
        expect(isAutoInstrumentationSuppressed()).toBe(true);
        await Promise.resolve();
        expect(isAutoInstrumentationSuppressed()).toBe(true);
      });

      expect(isAutoInstrumentationSuppressed()).toBe(false);
      restoreToolContext();
      expect(isAutoInstrumentationSuppressed()).toBe(true);
    });

    expect(isAutoInstrumentationSuppressed()).toBe(false);
  });

  it("keeps instrumentation allowed until every active allow frame exits", async () => {
    await runWithAutoInstrumentationSuppressed(async () => {
      const restoreFirstTool = enterAutoInstrumentationAllowed();
      const restoreSecondTool = enterAutoInstrumentationAllowed();

      expect(isAutoInstrumentationSuppressed()).toBe(false);
      restoreFirstTool();
      expect(isAutoInstrumentationSuppressed()).toBe(false);
      restoreSecondTool();
      expect(isAutoInstrumentationSuppressed()).toBe(true);
    });
  });
});
