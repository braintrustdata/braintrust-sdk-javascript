import { execFileSync } from "node:child_process";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { gzipSync, brotliCompressSync } from "node:zlib";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = path.join(root, ".context/bundling");
await mkdir(outputDir, { recursive: true });
const baseline = process.argv[2];
const entries = {
  root: path.join(root, "js/dist/node/index.js"),
  ...(baseline ? { baseline: path.resolve(baseline) } : {}),
};
// An optional baseline build uses the same installed runtime dependency versions.
if (baseline) {
  try {
    await symlink(
      path.join(root, "js/node_modules"),
      path.join(path.dirname(baseline), "node_modules"),
      "dir",
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
const report = {};
for (const [name, entry] of Object.entries(entries)) {
  const samples = [];
  for (let index = 0; index < 15; index++) {
    const sample = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const start = performance.now();
      const sdk = await import(${JSON.stringify(entry)});
      const imported = performance.now();
      sdk.currentSpan();
      const used = performance.now();
      console.log(JSON.stringify({ importMs: imported - start, firstUseMs: used - imported, rss: process.memoryUsage().rss }));
      process.exit(0);
    `,
      ],
      { encoding: "utf8", env: { ...process.env, BRAINTRUST_DEBUG: "false" } },
    );
    samples.push(JSON.parse(sample));
  }
  const sorted = (key) =>
    samples.map((sample) => sample[key]).sort((a, b) => a - b);
  report[name] = {
    importMedianMs: sorted("importMs")[7],
    importP95Ms: sorted("importMs")[14],
    firstUseMedianMs: sorted("firstUseMs")[7],
    rssMedianBytes: sorted("rss")[7],
    samples,
  };
  const bundle = await build({
    stdin: {
      contents: `import { traced } from ${JSON.stringify(entry)}; globalThis.run = traced;`,
      resolveDir: root,
    },
    nodePaths: [path.join(root, "js/node_modules")],
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const bytes = bundle.outputFiles[0].contents;
  report[name].bundle = {
    bytes: bytes.length,
    gzip: gzipSync(bytes).length,
    brotli: brotliCompressSync(bytes).length,
  };
}
await writeFile(
  path.join(outputDir, "import-benchmark.json"),
  JSON.stringify(report, null, 2) + "\n",
);
for (const [name, { samples, ...summary }] of Object.entries(report))
  console.log(name, summary);
