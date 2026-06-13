import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import iso from "../isomorph";
import { configureNode } from "../node/config";
import { BraintrustState, Prompt, RemoteEvalParameters } from "../logger";

configureNode();

const CACHE_ENV_VARS = [
  "BRAINTRUST_CACHE_LOCATION",
  "BRAINTRUST_DEBUG_LOG_LEVEL",
  "BRAINTRUST_PROMPT_CACHE_DIR",
  "BRAINTRUST_PROMPT_CACHE_MEMORY_MAX",
  "BRAINTRUST_PROMPT_CACHE_DISK_MAX",
  "BRAINTRUST_PARAMETERS_CACHE_DIR",
  "BRAINTRUST_PARAMETERS_CACHE_MEMORY_MAX",
  "BRAINTRUST_PARAMETERS_CACHE_DISK_MAX",
];

const promptKey = {
  projectId: "11111111-1111-4111-8111-111111111111",
  slug: "saved-prompt",
  version: "v1",
};

const parametersKey = {
  projectId: "22222222-2222-4222-8222-222222222222",
  slug: "saved-parameters",
  version: "v1",
};

const testPrompt = new Prompt(
  {
    id: "33333333-3333-4333-8333-333333333333",
    _xact_id: "v1",
    project_id: promptKey.projectId,
    name: "Saved prompt",
    slug: promptKey.slug,
  },
  {},
  false,
);

const testParameters = new RemoteEvalParameters({
  id: "44444444-4444-4444-8444-444444444444",
  _xact_id: "v1",
  project_id: parametersKey.projectId,
  name: "Saved parameters",
  slug: parametersKey.slug,
  description: null,
  function_type: "parameters",
  function_data: {
    type: "parameters",
    data: { prefix: "hello" },
    __schema: {
      type: "object",
      properties: {
        prefix: { type: "string" },
      },
    },
  },
});

describe("prompt and parameters cache modes", () => {
  const originalEnv = new Map<string, string | undefined>();
  const originalGzip = iso.gzip;
  const testDirs: string[] = [];

  beforeEach(() => {
    for (const envVar of CACHE_ENV_VARS) {
      originalEnv.set(envVar, process.env[envVar]);
      delete process.env[envVar];
    }
    iso.gzip = originalGzip;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const envVar of CACHE_ENV_VARS) {
      const value = originalEnv.get(envVar);
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
    originalEnv.clear();
    iso.gzip = originalGzip;
    vi.restoreAllMocks();

    await Promise.all(
      testDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    testDirs.length = 0;
  });

  async function makeTempDir() {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "braintrust-cache-mode-"));
    testDirs.push(dir);
    return dir;
  }

  async function configureCacheDirs() {
    const promptDir = await makeTempDir();
    const parametersDir = await makeTempDir();
    process.env.BRAINTRUST_PROMPT_CACHE_DIR = promptDir;
    process.env.BRAINTRUST_PARAMETERS_CACHE_DIR = parametersDir;
    return { promptDir, parametersDir };
  }

  it("mixed mode uses memory and disk caches", async () => {
    process.env.BRAINTRUST_CACHE_LOCATION = " MiXeD ";
    process.env.BRAINTRUST_PROMPT_CACHE_MEMORY_MAX = "1";
    process.env.BRAINTRUST_PARAMETERS_CACHE_MEMORY_MAX = "1";
    await configureCacheDirs();

    const state = new BraintrustState({});
    await state.promptCache.set(promptKey, testPrompt);
    await state.promptCache.set({ ...promptKey, slug: "other" }, testPrompt);
    await state.parametersCache.set(parametersKey, testParameters);
    await state.parametersCache.set(
      { ...parametersKey, slug: "other" },
      testParameters,
    );

    const nextState = new BraintrustState({});
    expect(await nextState.promptCache.get(promptKey)).toEqual(testPrompt);
    expect(await nextState.parametersCache.get(parametersKey)).toEqual(
      testParameters,
    );
  });

  it("memory mode does not write to disk", async () => {
    process.env.BRAINTRUST_CACHE_LOCATION = "memory";
    const { promptDir, parametersDir } = await configureCacheDirs();

    const state = new BraintrustState({});
    await state.promptCache.set(promptKey, testPrompt);
    await state.parametersCache.set(parametersKey, testParameters);

    expect(await state.promptCache.get(promptKey)).toEqual(testPrompt);
    expect(await state.parametersCache.get(parametersKey)).toEqual(
      testParameters,
    );
    expect(await fs.readdir(promptDir)).toEqual([]);
    expect(await fs.readdir(parametersDir)).toEqual([]);

    const nextState = new BraintrustState({});
    expect(await nextState.promptCache.get(promptKey)).toBeUndefined();
    expect(await nextState.parametersCache.get(parametersKey)).toBeUndefined();
  });

  it("disk mode does not warm memory", async () => {
    process.env.BRAINTRUST_CACHE_LOCATION = "disk";
    const { promptDir, parametersDir } = await configureCacheDirs();

    const state = new BraintrustState({});
    await state.promptCache.set(promptKey, testPrompt);
    await state.parametersCache.set(parametersKey, testParameters);

    const nextState = new BraintrustState({});
    expect(await nextState.promptCache.get(promptKey)).toEqual(testPrompt);
    expect(await nextState.parametersCache.get(parametersKey)).toEqual(
      testParameters,
    );

    await fs.rm(promptDir, { recursive: true, force: true });
    await fs.rm(parametersDir, { recursive: true, force: true });

    expect(await nextState.promptCache.get(promptKey)).toBeUndefined();
    expect(await nextState.parametersCache.get(parametersKey)).toBeUndefined();
  });

  it("none mode disables all cache reads and writes", async () => {
    process.env.BRAINTRUST_CACHE_LOCATION = "none";
    const { promptDir, parametersDir } = await configureCacheDirs();

    const state = new BraintrustState({});
    await state.promptCache.set(promptKey, testPrompt);
    await state.parametersCache.set(parametersKey, testParameters);

    expect(await state.promptCache.get(promptKey)).toBeUndefined();
    expect(await state.parametersCache.get(parametersKey)).toBeUndefined();
    expect(await fs.readdir(promptDir)).toEqual([]);
    expect(await fs.readdir(parametersDir)).toEqual([]);
  });

  it("invalid cache mode warns once and falls back to mixed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.BRAINTRUST_CACHE_LOCATION = "invalid";
    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "warn";
    await configureCacheDirs();

    const state = new BraintrustState({});
    await state.promptCache.set(promptKey, testPrompt);
    await state.parametersCache.set(parametersKey, testParameters);

    const nextState = new BraintrustState({});
    expect(await nextState.promptCache.get(promptKey)).toEqual(testPrompt);
    expect(await nextState.parametersCache.get(parametersKey)).toEqual(
      testParameters,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[braintrust]",
      'Invalid BRAINTRUST_CACHE_LOCATION value "invalid". Expected "mixed", "memory", "disk", or "none". Falling back to "mixed".',
    );
  });

  it("unset or invalid memory max defaults to 1024 entries", async () => {
    process.env.BRAINTRUST_CACHE_LOCATION = "memory";
    process.env.BRAINTRUST_PROMPT_CACHE_MEMORY_MAX = "invalid";

    const state = new BraintrustState({});
    for (let i = 0; i < 1025; i++) {
      await state.promptCache.set(
        { ...promptKey, slug: `prompt-${i}` },
        testPrompt,
      );
      await state.parametersCache.set(
        { ...parametersKey, slug: `parameters-${i}` },
        testParameters,
      );
    }

    expect(
      await state.promptCache.get({ ...promptKey, slug: "prompt-0" }),
    ).toBeUndefined();
    expect(
      await state.parametersCache.get({
        ...parametersKey,
        slug: "parameters-0",
      }),
    ).toBeUndefined();
    expect(
      await state.promptCache.get({ ...promptKey, slug: "prompt-1024" }),
    ).toEqual(testPrompt);
    expect(
      await state.parametersCache.get({
        ...parametersKey,
        slug: "parameters-1024",
      }),
    ).toEqual(testParameters);
  });

  it("disk mode disables caching and warns once when disk cache is unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.BRAINTRUST_CACHE_LOCATION = "disk";
    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "warn";
    iso.gzip = undefined;

    const state = new BraintrustState({});
    await state.promptCache.set(promptKey, testPrompt);
    expect(await state.promptCache.get(promptKey)).toBeUndefined();
    await state.parametersCache.set(parametersKey, testParameters);
    expect(await state.parametersCache.get(parametersKey)).toBeUndefined();

    new BraintrustState({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[braintrust]",
      'Disk cache is not supported on this platform, so BRAINTRUST_CACHE_LOCATION="disk" disables prompt and parameters caching.',
    );
  });
});
