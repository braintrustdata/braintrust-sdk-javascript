import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { expect, test } from "vitest";

test("production sources cannot depend on generated backend definitions", () => {
  for (const directory of [__dirname, resolve(__dirname, "../util")]) {
    for (const file of readdirSync(directory, { recursive: true })) {
      const name = String(file);
      if (
        !/\.[cm]?tsx?$/.test(name) ||
        /\.test\.[cm]?tsx?$/.test(name) ||
        /(?:^|\/)generated_(?:plain_)?types\.ts$/.test(name)
      ) {
        continue;
      }
      const path = join(directory, name);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const dependencies: string[] = [];
      function visit(node: ts.Node) {
        if (
          ts.isStringLiteral(node) &&
          /(?:^|\/)generated_(?:plain_)?types(?:\.[cm]?[jt]s)?$/.test(node.text)
        ) {
          dependencies.push(node.text);
        }
        node.forEachChild(visit);
      }
      visit(source);
      expect(dependencies, path).toEqual([]);
    }
  }
});

test("public bundles exclude the backend schema modules", async () => {
  const result = await build({
    entryPoints: [
      "node",
      "browser",
      "edge-light",
      "workerd",
      "instrumentation",
    ].map((entry) => resolve(__dirname, entry, "index.ts")),
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    splitting: true,
    outdir: "sdk-boundary-check",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  expect(
    Object.keys(result.metafile.inputs).filter((file) =>
      /generated_(?:plain_)?types/.test(file),
    ),
  ).toEqual([]);
  expect(
    Object.keys(result.metafile.inputs).some((file) =>
      file.endsWith("sdk-schemas.ts"),
    ),
  ).toBe(true);
});
