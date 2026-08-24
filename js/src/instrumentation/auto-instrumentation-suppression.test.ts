import { beforeAll, describe, expect, it } from "vitest";
import { configureNode } from "../node/config";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationAllowed,
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

      await runWithAutoInstrumentationAllowed(async () => {
        expect(isAutoInstrumentationSuppressed()).toBe(false);

        await runWithAutoInstrumentationSuppressed(async () => {
          expect(isAutoInstrumentationSuppressed()).toBe(true);
          await Promise.resolve();
          expect(isAutoInstrumentationSuppressed()).toBe(true);
        });

        expect(isAutoInstrumentationSuppressed()).toBe(false);
      });
      expect(isAutoInstrumentationSuppressed()).toBe(true);
    });

    expect(isAutoInstrumentationSuppressed()).toBe(false);
  });

  it("restores nested allow frames at each callback boundary", async () => {
    await runWithAutoInstrumentationSuppressed(async () => {
      await runWithAutoInstrumentationAllowed(async () => {
        expect(isAutoInstrumentationSuppressed()).toBe(false);
        await runWithAutoInstrumentationAllowed(async () => {
          expect(isAutoInstrumentationSuppressed()).toBe(false);
          await Promise.resolve();
          expect(isAutoInstrumentationSuppressed()).toBe(false);
        });
        expect(isAutoInstrumentationSuppressed()).toBe(false);
      });
      expect(isAutoInstrumentationSuppressed()).toBe(true);
    });
  });
});
