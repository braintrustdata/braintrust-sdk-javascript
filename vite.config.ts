import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 80,
    sortImports: false,
    sortPackageJson: false,
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules/**",
      ".context/**",
      "js/tests/auto-instrumentations/output-*/**",
      "patches/**/*.patch",
      "e2e/**/__snapshots__/**",
      "**/pnpm-lock.yaml",
      "**/deno.lock",
      "**/generated*_types.ts",
      "js/scripts/openapi_zod_client_output_template.hbs",
      ".agents/skills/dotagents/**",
    ],
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    plugins: ["typescript", "unicorn", "node"],
    categories: { correctness: "off" },
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules/**",
      ".context/**",
      "**/vendor/**",
      "**/generated*_types.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
      "js/src/auto-instrumentations/**",
      "js/examples/**",
      "js/smoke/**",
      "js/tests/**",
      "js/scripts/**",
      "e2e/**",
      "integrations/**",
      "dev-packages/**",
      "scripts/**",
    ],
    jsPlugins: ["./js/node_modules/eslint-plugin-n/lib/index.js"],
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: false,
        },
      ],
      "prefer-const": "error",
      "typescript/no-explicit-any": "warn",
      "typescript/no-empty-object-type": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/prefer-as-const": "error",
      "typescript/no-array-constructor": "error",
      "typescript/no-duplicate-enum-values": "error",
      "typescript/no-extra-non-null-assertion": "error",
      "typescript/no-misused-new": "error",
      "typescript/no-namespace": "error",
      "typescript/no-non-null-asserted-optional-chain": "error",
      "typescript/no-this-alias": "error",
      "typescript/no-unnecessary-type-constraint": "error",
      "typescript/no-wrapper-object-types": "error",
      "typescript/prefer-namespace-keyword": "error",
      "typescript/triple-slash-reference": "error",
      "typescript/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
      "no-unused-expressions": ["error", { allowShortCircuit: true }],
      "n/no-unsupported-features/node-builtins": [
        "error",
        { version: ">=22.18.0", allowExperimental: true },
      ],
      "n/no-unsupported-features/es-builtins": [
        "error",
        { version: ">=22.18.0" },
      ],
      "n/no-unsupported-features/es-syntax": [
        "error",
        { version: ">=22.18.0" },
      ],
    },
    overrides: [
      {
        files: ["js/src/**/*.ts", "js/util/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**/generated_types",
                    "**/generated_plain_types",
                    "**/generated_types.ts",
                    "**/generated_plain_types.ts",
                  ],
                  message:
                    "Use SDK-owned types and validators; generated backend types are compatibility fixtures.",
                },
              ],
            },
          ],
          "no-restricted-properties": [
            "error",
            ...["log", "warn", "error", "debug", "info", "trace"].map(
              (property) => ({
                object: "console",
                property,
                message: "Use debugLogger instead of console for SDK logging.",
              }),
            ),
            {
              property: "enterWith",
              message:
                "Use AsyncLocalStorage.run(); enterWith is unsupported in Workers.",
            },
          ],
          "unicorn/prefer-node-protocol": "error",
        },
      },
      {
        files: ["js/src/**/*.ts"],
        excludeFiles: ["js/src/{node,browser,workerd,edge-light}/index.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**/generated_types",
                    "**/generated_plain_types",
                    "**/generated_types.ts",
                    "**/generated_plain_types.ts",
                  ],
                  message:
                    "Use SDK-owned types and validators; generated backend types are compatibility fixtures.",
                },
                {
                  group: [
                    "./exports",
                    "./exports.ts",
                    "../exports",
                    "../exports.ts",
                  ],
                  message:
                    "Import from the specific implementation module instead of the public barrel.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["js/src/queue.bench.ts"],
        rules: { "no-restricted-properties": "off" },
      },
    ],
  },
});
