import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import nodeImport from "eslint-plugin-node-import";
import tsupConfigImport from "./tsup.config";

// Handle both ESM and CJS module formats
const tsupConfig = Array.isArray(tsupConfigImport)
  ? tsupConfigImport
  : tsupConfigImport.default || [];

// Extract entry points from tsup config, excluding CLI
const entryFiles = tsupConfig
  .flatMap((config) => {
    const entries = Array.isArray(config.entry)
      ? config.entry
      : Object.values(config.entry);
    return entries;
  })
  .filter((entry) => !entry.includes("cli"));

export default [
  {
    ignores: [
      "dist/**",
      "dev/dist/**",
      "util/dist/**",
      "node_modules/**",
      "vendor/**",
      "examples/**",
      "scripts/**",
      ".turbo/**",
      "docs/**",
      "test-ai-sdk-wrapper/**",
      "vercel/**",
      // TODO: Add these back once tsconfig.json includes them, so that
      // typed linting (and all other config blocks) can run on them too.
      "**/*.test.ts",
      "**/*.test.tsx",
      "src/auto-instrumentations/**",
    ],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "node-import": nodeImport,
    },
    rules: {
      // Base TypeScript rules
      ...tseslint.configs.recommended.rules,
      // TODO: Fix violations and re-enable as "error"
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "none",
          ignoreRestSiblings: false,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "prefer-const": "error",
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-require-imports": "off",
      // TODO: Fix violations and re-enable as "error"
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
      "no-unused-expressions": ["error", { allowShortCircuit: true }],
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/prefer-as-const": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "console",
          property: "log",
          message: "Use debugLogger instead of console for SDK logging.",
        },
        {
          object: "console",
          property: "warn",
          message: "Use debugLogger instead of console for SDK logging.",
        },
        {
          object: "console",
          property: "error",
          message: "Use debugLogger instead of console for SDK logging.",
        },
        {
          object: "console",
          property: "debug",
          message: "Use debugLogger instead of console for SDK logging.",
        },
        {
          object: "console",
          property: "info",
          message: "Use debugLogger instead of console for SDK logging.",
        },
        {
          object: "console",
          property: "trace",
          message: "Use debugLogger instead of console for SDK logging.",
        },
      ],
      // Require node: protocol for Node.js built-in imports (for Deno compatibility)
      // This plugin automatically detects ALL Node.js built-ins - no manual list needed!
      "node-import/prefer-node-protocol": "error",
    },
  },
  {
    files: ["src/queue.bench.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/cli/**",
      "src/debug-logger.ts",
      "src/framework.ts",
      "src/framework2.ts",
      "src/isomorph.ts",
      "src/sandbox.ts",
      "src/template/**",
      "src/reporters/**",
      "src/prompt-cache/**",
      "src/eval-parameters.ts",
      "src/wrappers/**",
      "src/instrumentation/**",
      "src/auto-instrumentations/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cli", "**/cli/**", "./cli", "./cli/**"],
              message:
                "Importing from 'cli' directory is not allowed. CLI code should not be imported by SDK code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [...entryFiles, "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "./exports",
                "./exports.ts",
                "../exports",
                "../exports.ts",
              ],
              message:
                "Direct imports from 'exports.ts' are not allowed. Import from the specific module instead. Only entry points (index.ts, browser.ts) should import from exports.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      ...entryFiles,
      // Also include exports files which are imported by entry points
      "src/exports.ts",
    ],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
  },
];
