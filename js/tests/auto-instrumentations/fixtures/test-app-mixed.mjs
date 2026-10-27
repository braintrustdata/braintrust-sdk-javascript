import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Completions as ESMCompletions } from "openai/resources/chat/completions.mjs";

const { generateText: importedGenerateText } = await import(
  pathToFileURL(
    join(
      process.env.TEST_CJS_PROVIDER_DIR,
      "node_modules/ai-imported/dist/index.js",
    ),
  ).href
);
const { generateText: requiredGenerateText } = createRequire(import.meta.url)(
  join(
    process.env.TEST_CJS_PROVIDER_DIR,
    "node_modules/ai-required/dist/index.js",
  ),
);

const completions = new ESMCompletions({
  post: async () => ({ choices: [], model: "gpt-4" }),
});
await completions.create({ model: "gpt-4", messages: [] });
await importedGenerateText({ prompt: "imported CJS" });
await requiredGenerateText({ prompt: "required CJS" });
