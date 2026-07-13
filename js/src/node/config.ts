import { AsyncLocalStorage } from "node:async_hooks";
import * as diagnostics_channel from "node:diagnostics_channel";
import * as path from "node:path";
import { patchTracingChannel } from "../auto-instrumentations/patch-tracing-channel";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as fsSync from "node:fs";
import * as crypto from "node:crypto";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import * as dotenv from "dotenv";

import iso from "../isomorph";
import { getRepoInfo, getPastNAncestors } from "../gitutil";
import { getCallerLocation } from "../stackutil";
import { _internalSetInitialState } from "../logger";
import { registry } from "../instrumentation/registry";
import { readDisabledInstrumentationEnvConfig } from "../instrumentation/config";
import { getDefaultModuleExportPatchConfigs } from "../auto-instrumentations/configs/all";
import { nodeModuleExportPatchRuntime } from "../auto-instrumentations/loader/module-hooks/node-runtime";
import { installModuleExportPatchRunner } from "../auto-instrumentations/loader/module-hooks/registry";

const BRAINTRUST_ENV_SEARCH_PARENT_LIMIT = 64;

export function configureNode() {
  iso.buildType = "node";

  iso.getRepoInfo = getRepoInfo;
  iso.getPastNAncestors = getPastNAncestors;
  iso.getEnv = (name) => {
    const value = process.env[name];
    return name === "BRAINTRUST_API_KEY" && !value?.trim() ? undefined : value;
  };
  iso.getBraintrustApiKey = async () => {
    const value = process.env.BRAINTRUST_API_KEY;
    if (value?.trim()) {
      return value;
    }

    // Kick off the cwd/parent reads together, then drain them nearest-first so
    // a slower local file still beats a faster parent.
    const envPaths = [];
    for (
      let dir = process.cwd(), depth = 0;
      depth <= BRAINTRUST_ENV_SEARCH_PARENT_LIMIT;
      dir = path.dirname(dir), depth++
    ) {
      envPaths.push(path.join(dir, ".env.braintrust"));
      if (path.dirname(dir) === dir) {
        break;
      }
    }

    type ReadResult =
      | { envPath: string; index: number; contents: string }
      | { envPath: string; index: number; error: unknown };

    const pending = new Map<number, Promise<ReadResult>>();
    envPaths.forEach((envPath, index) => {
      pending.set(
        index,
        fs.readFile(envPath, "utf8").then(
          (contents) => ({ contents, envPath, index }),
          (error) => ({ error, envPath, index }),
        ),
      );
    });

    const results: Array<ReadResult | undefined> = [];
    let nearestUnresolvedIndex = 0;
    while (pending.size > 0) {
      const result = await Promise.race(pending.values());
      pending.delete(result.index);
      results[result.index] = result;

      while (results[nearestUnresolvedIndex]) {
        const nearestResult = results[nearestUnresolvedIndex]!;
        if ("contents" in nearestResult) {
          const parsed = dotenv.parse(nearestResult.contents);
          const apiKey = parsed.BRAINTRUST_API_KEY;
          return apiKey?.trim() ? apiKey : undefined;
        }

        const e = nearestResult.error;
        if (
          typeof e === "object" &&
          e !== null &&
          "code" in e &&
          e.code === "ENOENT"
        ) {
          nearestUnresolvedIndex++;
          continue;
        }
        return undefined;
      }
    }

    return undefined;
  };
  iso.getCallerLocation = getCallerLocation;
  iso.newAsyncLocalStorage = <T>() => new AsyncLocalStorage<T>();
  iso.newTracingChannel = <_M = any>(nameOrChannels: string | object) =>
    (diagnostics_channel as any).tracingChannel(nameOrChannels) as any;

  // Patch TracingChannel.prototype.tracePromise to handle APIPromise and other
  // Promise subclasses (mirrors the fix in hook.mts for the --import loader path).
  patchTracingChannel((diagnostics_channel as any).tracingChannel);
  iso.processOn = (event: string, handler: (code: unknown) => void) => {
    process.on(event, handler);
  };
  iso.basename = path.basename;
  iso.writeln = (text: string) => process.stdout.write(text + "\n");
  iso.pathJoin = path.join;
  iso.pathDirname = path.dirname;
  iso.mkdir = fs.mkdir;
  iso.writeFile = fs.writeFile;
  iso.readFile = fs.readFile;
  iso.readdir = fs.readdir;
  iso.stat = fs.stat;
  iso.statSync = fsSync.statSync;
  iso.utimes = fs.utimes;
  iso.unlink = fs.unlink;
  iso.homedir = os.homedir;
  iso.tmpdir = os.tmpdir;
  iso.writeFileSync = fsSync.writeFileSync;
  iso.appendFileSync = fsSync.appendFileSync;
  iso.readFileSync = (filename: string, encoding: string) =>
    fsSync.readFileSync(filename, encoding as BufferEncoding);
  iso.unlinkSync = fsSync.unlinkSync;
  iso.openFile = fs.open;
  iso.gzip = promisify(zlib.gzip);
  iso.gunzip = promisify(zlib.gunzip);
  iso.hash = (data) => crypto.createHash("sha256").update(data).digest("hex");

  _internalSetInitialState();

  // Bundled wrappers call the module export runner through globalThis. Installing
  // it here covers applications that import Braintrust without hook.mjs.
  const disabled = readDisabledInstrumentationEnvConfig(
    iso.getEnv("BRAINTRUST_DISABLE_INSTRUMENTATION"),
  ).integrations;
  installModuleExportPatchRunner(
    getDefaultModuleExportPatchConfigs({
      disabledIntegrationConfig: disabled,
      target: "node",
    }),
    nodeModuleExportPatchRuntime,
  );

  // Enable auto-instrumentation
  registry.enable();
}
