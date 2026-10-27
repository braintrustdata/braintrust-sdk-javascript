import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as fsSync from "node:fs";
import * as crypto from "node:crypto";
import { formatWithOptions, inspect, promisify } from "node:util";
import * as zlib from "node:zlib";
import * as dotenv from "dotenv";

import { createIsomorph, type Common } from "../isomorph-base";
import { getRepoInfo, getPastNAncestors } from "../gitutil";
import { getCallerLocation } from "../stackutil";
const BRAINTRUST_ENV_SEARCH_PARENT_LIMIT = 64;

export function createNodeIsomorph(): Common {
  const iso = createIsomorph();
  iso.buildType = "node";

  iso.getRepoInfo = getRepoInfo;
  iso.getPastNAncestors = getPastNAncestors;
  iso.getEnv = (name) => {
    const value = process.env[name];
    if (name === "BRAINTRUST_API_KEY") {
      return value?.trim() ? value : undefined;
    }
    if (
      (name === "BRAINTRUST_ENVIRONMENT_TYPE" ||
        name === "BRAINTRUST_ENVIRONMENT_NAME") &&
      !value?.trim()
    ) {
      return getNearestBraintrustEnvValue(name);
    }
    return value;
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
  iso.formatLogMessage = (...args) =>
    formatWithOptions(
      { customInspect: false },
      ...args.map((value, index) =>
        index > 0 &&
        value !== null &&
        (typeof value === "object" || typeof value === "function")
          ? inspect(value, { customInspect: false })
          : value,
      ),
    );
  iso.newAsyncLocalStorage = <T>() => new AsyncLocalStorage<T>();
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
  iso.hmacSha256 = (key, data) =>
    crypto.createHmac("sha256", key).update(data).digest("hex");
  iso.timingSafeEqual = (left, right) => {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      crypto.timingSafeEqual(leftBuffer, rightBuffer)
    );
  };
  return iso;
}

function getNearestBraintrustEnvValue(name: string): string | undefined {
  for (
    let dir = process.cwd(), depth = 0;
    depth <= BRAINTRUST_ENV_SEARCH_PARENT_LIMIT;
    dir = path.dirname(dir), depth++
  ) {
    const envPath = path.join(dir, ".env.braintrust");
    try {
      const parsed = dotenv.parse(fsSync.readFileSync(envPath, "utf8"));
      const value = parsed[name];
      return value?.trim() ? value : undefined;
    } catch (e) {
      if (
        typeof e !== "object" ||
        e === null ||
        !("code" in e) ||
        e.code !== "ENOENT"
      ) {
        return undefined;
      }
    }
    if (path.dirname(dir) === dir) {
      break;
    }
  }
  return undefined;
}
