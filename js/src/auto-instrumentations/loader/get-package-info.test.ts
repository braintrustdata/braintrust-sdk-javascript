import { afterEach, expect, it } from "vite-plus/test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageInfo } from "./get-package-info";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("reads canonical package identity through a directory symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "braintrust-package-info-"));
  dirs.push(dir);
  const target = join(dir, "target");
  const alias = join(dir, "alias");
  mkdirSync(target);
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ name: "openai", version: "6.0.0" }),
  );
  symlinkSync(target, alias, "junction");

  expect(getPackageInfo(alias)).toEqual({ name: "openai", version: "6.0.0" });
});

it("does not substitute the Node version for missing package metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "braintrust-package-info-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "openai" }));

  expect(getPackageInfo(dir)).toEqual({ name: "openai", version: undefined });
});

it("recovers after a package manifest becomes available", () => {
  const dir = mkdtempSync(join(tmpdir(), "braintrust-package-info-"));
  dirs.push(dir);
  expect(getPackageInfo(dir)).toBeUndefined();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "openai", version: "6.0.0" }),
  );

  expect(getPackageInfo(dir)).toEqual({ name: "openai", version: "6.0.0" });
});
