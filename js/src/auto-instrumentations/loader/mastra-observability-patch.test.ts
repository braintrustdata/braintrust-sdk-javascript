import { describe, expect, it } from "vitest";
import {
  installMastraExporterFactory,
  patchMastraExports,
} from "./mastra-observability-patch";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/auto-instrumentations/fixtures",
);
const mastraCoreBaseDir = join(fixturesDir, "node_modules/@mastra/core");

describe("patchMastraExports — runtime @mastra/observability export", () => {
  it("wraps Observability and appends the Braintrust exporter", () => {
    delete (globalThis as any).__braintrustMastraExporterFactory;
    installMastraExporterFactory(() => ({ name: "braintrust" }));

    class Observability {
      public config: unknown;
      constructor(config: unknown) {
        this.config = config;
      }
    }
    const namespace = { Observability };

    patchMastraExports(namespace, { moduleName: "@mastra/observability" });
    patchMastraExports(namespace, { moduleName: "@mastra/observability" });

    const instance = new namespace.Observability({
      configs: {
        default: {
          exporters: [{ name: "other" }],
          serviceName: "service",
        },
      },
    });

    expect(instance.config).toEqual({
      configs: {
        default: {
          exporters: [{ name: "other" }, { name: "braintrust" }],
          serviceName: "service",
        },
      },
    });
  });

  it("does not duplicate an existing Braintrust exporter", () => {
    delete (globalThis as any).__braintrustMastraExporterFactory;
    installMastraExporterFactory(() => ({ name: "braintrust" }));

    class Observability {
      public config: unknown;
      constructor(config: unknown) {
        this.config = config;
      }
    }
    const namespace = { Observability };

    patchMastraExports(namespace, { moduleName: "@mastra/observability" });

    const instance = new namespace.Observability({
      configs: {
        default: {
          exporters: [{ name: "braintrust" }],
          serviceName: "service",
        },
      },
    });

    expect(instance.config).toEqual({
      configs: {
        default: {
          exporters: [{ name: "braintrust" }],
          serviceName: "service",
        },
      },
    });
  });

  it("creates a default config when none is provided", () => {
    delete (globalThis as any).__braintrustMastraExporterFactory;
    installMastraExporterFactory(() => ({ name: "braintrust" }));

    class Observability {
      public config: unknown;
      constructor(config: unknown) {
        this.config = config;
      }
    }
    const namespace = { Observability };

    patchMastraExports(namespace, { moduleName: "@mastra/observability" });

    const instance = new namespace.Observability(undefined);

    expect(instance.config).toEqual({
      configs: {
        default: {
          exporters: [{ name: "braintrust" }],
          serviceName: "mastra",
        },
      },
    });
  });
});

describe("patchMastraExports — runtime @mastra/core export", () => {
  it("wraps Mastra and injects default Observability when config has none", () => {
    delete (globalThis as any).__braintrustMastraExporterFactory;
    installMastraExporterFactory(() => ({ name: "braintrust" }));

    class Mastra {
      public observability: any;
      constructor(config: any = {}) {
        this.observability = config.observability;
      }
    }
    const namespace = { Mastra };

    patchMastraExports(namespace, {
      baseDir: mastraCoreBaseDir,
      moduleName: "@mastra/core",
    });
    patchMastraExports(namespace, {
      baseDir: mastraCoreBaseDir,
      moduleName: "@mastra/core",
    });

    const instance = new namespace.Mastra({});

    expect(instance.observability).toBeTruthy();
    expect(
      instance.observability.config.configs.default.exporters.map(
        (exporter: { name: string }) => exporter.name,
      ),
    ).toEqual(["braintrust"]);
  });

  it("preserves a user-provided observability config", () => {
    delete (globalThis as any).__braintrustMastraExporterFactory;
    installMastraExporterFactory(() => ({ name: "braintrust" }));

    class Mastra {
      public observability: any;
      constructor(config: any = {}) {
        this.observability = config.observability;
      }
    }
    const namespace = { Mastra };
    const observability = { user: true };

    patchMastraExports(namespace, {
      baseDir: mastraCoreBaseDir,
      moduleName: "@mastra/core",
    });

    const instance = new namespace.Mastra({ observability });

    expect(instance.observability).toBe(observability);
  });

  it("is a no-op when @mastra/observability is unavailable", () => {
    class Mastra {}
    const namespace = { Mastra };

    patchMastraExports(namespace, {
      baseDir: dirname(fileURLToPath(import.meta.url)),
      moduleName: "@mastra/core",
    });

    expect(namespace.Mastra).toBe(Mastra);
  });
});
