import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import iso from "../isomorph";
import { configureNode } from "./config";

describe("configureNode .env.braintrust API key lookup", () => {
  let originalApiKey: string | undefined;
  let originalCwd: string;
  let tempDir: string | undefined;

  beforeEach(async () => {
    configureNode();
    originalApiKey = process.env.BRAINTRUST_API_KEY;
    originalCwd = process.cwd();
    delete process.env.BRAINTRUST_API_KEY;
    tempDir = await mkdtemp(path.join(tmpdir(), "bt-env-"));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalApiKey === undefined) {
      delete process.env.BRAINTRUST_API_KEY;
    } else {
      process.env.BRAINTRUST_API_KEY = originalApiKey;
    }
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  async function writeBraintrustEnv(dir: string, contents: string) {
    await writeFile(path.join(dir, ".env.braintrust"), contents);
  }

  test("finds BRAINTRUST_API_KEY in the nearest parent .env.braintrust", async () => {
    const nested = path.join(tempDir!, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=parent-key\n");

    process.chdir(nested);

    await expect(iso.getBraintrustApiKey()).resolves.toBe("parent-key");
  });

  test("uses the nearest .env.braintrust instead of a higher parent", async () => {
    const nested = path.join(tempDir!, "packages", "app");
    const packageDir = path.dirname(nested);
    await mkdir(nested, { recursive: true });
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=root-key\n");
    await writeBraintrustEnv(packageDir, "BRAINTRUST_API_KEY=package-key\n");

    process.chdir(nested);

    await expect(iso.getBraintrustApiKey()).resolves.toBe("package-key");
  });

  test.each([
    ["missing", "OTHER=value\n"],
    ["blank", 'BRAINTRUST_API_KEY="   "\n'],
  ])(
    "stops at the nearest .env.braintrust when the key is %s",
    async (_caseName, nearestContents) => {
      const nested = path.join(tempDir!, "packages", "app");
      const packageDir = path.dirname(nested);
      await mkdir(nested, { recursive: true });
      await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=root-key\n");
      await writeBraintrustEnv(packageDir, nearestContents);

      process.chdir(nested);

      await expect(iso.getBraintrustApiKey()).resolves.toBeUndefined();
    },
  );

  test("uses a non-blank process.env BRAINTRUST_API_KEY before .env.braintrust", async () => {
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=file-key\n");
    process.env.BRAINTRUST_API_KEY = "env-key";
    process.chdir(tempDir!);

    await expect(iso.getBraintrustApiKey()).resolves.toBe("env-key");
  });

  test("falls back to .env.braintrust when process.env BRAINTRUST_API_KEY is blank", async () => {
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=file-key\n");
    process.env.BRAINTRUST_API_KEY = "   ";
    process.chdir(tempDir!);

    await expect(iso.getBraintrustApiKey()).resolves.toBe("file-key");
  });

  test("searches the cwd and at most 64 parent directories", async () => {
    const segments = Array.from({ length: 65 }, () => "d");
    const nested = path.join(tempDir!, ...segments);
    await mkdir(nested, { recursive: true });
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=too-high\n");

    process.chdir(nested);

    await expect(iso.getBraintrustApiKey()).resolves.toBeUndefined();

    await writeBraintrustEnv(
      path.join(tempDir!, segments[0]),
      "BRAINTRUST_API_KEY=boundary-key\n",
    );

    await expect(iso.getBraintrustApiKey()).resolves.toBe("boundary-key");
  });

  test("supports dotenv syntax without reading other variables", async () => {
    await writeBraintrustEnv(
      tempDir!,
      'export BRAINTRUST_API_KEY="quoted-key" # comment\nOTHER=value\n',
    );
    process.chdir(tempDir!);

    await expect(iso.getBraintrustApiKey()).resolves.toBe("quoted-key");
    expect(iso.getEnv("OTHER")).toBeUndefined();
  });

  test("does not populate process.env from .env.braintrust", async () => {
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=file-key\n");
    process.chdir(tempDir!);

    await expect(iso.getBraintrustApiKey()).resolves.toBe("file-key");
    expect(process.env.BRAINTRUST_API_KEY).toBeUndefined();
  });

  test("returns undefined when the nearest .env.braintrust cannot be read", async () => {
    const nested = path.join(tempDir!, "packages", "app");
    const packageDir = path.dirname(nested);
    await mkdir(nested, { recursive: true });
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=root-key\n");
    await mkdir(path.join(packageDir, ".env.braintrust"));

    process.chdir(nested);

    await expect(iso.getBraintrustApiKey()).resolves.toBeUndefined();
  });

  test("keeps iso.getEnv as an environment-only lookup", async () => {
    await writeBraintrustEnv(tempDir!, "BRAINTRUST_API_KEY=file-key\n");
    process.chdir(tempDir!);

    expect(iso.getEnv("BRAINTRUST_API_KEY")).toBeUndefined();
    await expect(iso.getBraintrustApiKey()).resolves.toBe("file-key");
  });
});

describe("configureNode optional module loading", () => {
  let originalCwd: string;
  let app: string;

  async function installPackage(name: string, source: string) {
    const dir = path.join(app, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name, main: "index.js" }),
    );
    await writeFile(path.join(dir, "index.js"), source);
  }

  beforeEach(async () => {
    configureNode();
    originalCwd = process.cwd();
    app = await mkdtemp(path.join(tmpdir(), "bt-optional-"));
    process.chdir(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(app, { force: true, recursive: true });
  });

  test("loads a package the app installed", async () => {
    await installPackage("@bt-test/installed", "module.exports = 'loaded';");
    expect(iso.loadOptionalModule!("@bt-test/installed")).toBe("loaded");
  });

  test("returns undefined for a package that is not installed", () => {
    expect(iso.loadOptionalModule!("@bt-test/missing")).toBeUndefined();
  });

  test("throws when an installed package fails to load", async () => {
    await installPackage("@bt-test/broken", "throw new Error('broken');");
    expect(() => iso.loadOptionalModule!("@bt-test/broken")).toThrow("broken");
  });
});
