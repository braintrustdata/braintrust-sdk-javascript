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

import iso from "../isomorph";
import { getRepoInfo, getPastNAncestors } from "../gitutil";
import { getCallerLocation } from "../stackutil";
import { _internalSetInitialState } from "../logger";
import { registry } from "../instrumentation/registry";

export function configureNode() {
  iso.buildType = "node";

  iso.getRepoInfo = getRepoInfo;
  iso.getPastNAncestors = getPastNAncestors;
  iso.getEnv = (name) => process.env[name];
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

  // Enable auto-instrumentation
  registry.enable();
}
