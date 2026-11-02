# OpenTelemetry Integration Testing Architecture

## Overview

This package (`@braintrust/otel`) integrates Braintrust with OpenTelemetry. To ensure compatibility across different OpenTelemetry versions, we use a unique testing architecture with isolated test environments.

## Directory Structure

```
sdk/integrations/otel-js/
├── src/                          # Main source code (published)
│   ├── index.ts                  # Public API
│   ├── otel.ts                   # Core implementation
│   ├── context.ts                # Context management
│   └── *.test.ts                 # Test files
├── tests/
│   └── utils.ts                  # Cross-version compatibility helpers
├── dist/                         # Built package (tsup output)
├── package.json                  # Main package definition
├── otel-v1/                      # Test environment for OTel 1.x
│   ├── src -> ../src             # SYMLINK to parent src/
│   ├── package.json              # Pins OTel 1.x versions
│   ├── vite.config.ts          # Aliases to local node_modules
│   ├── pnpm-lock.yaml            # Independent lockfile
│   └── node_modules/             # Isolated v1.x dependencies
└── otel-v2/                      # Test environment for OTel 2.x
    ├── src -> ../src             # SYMLINK to parent src/
    ├── package.json              # Pins OTel 2.x versions
    ├── vite.config.ts          # Aliases to local node_modules
    ├── pnpm-lock.yaml            # Independent lockfile
    └── node_modules/             # Isolated v2.x dependencies
```

## How It Works

### 1. Single Source, Multiple Test Environments

- **Source code** lives in `src/` and is shared across both test environments via symlinks
- **Test execution** happens from `otel-v1/` and `otel-v2/` directories
- Each test environment has its own `package.json` with specific OpenTelemetry version constraints

### 2. Symlinks

Both `otel-v1/` and `otel-v2/` contain symlinks to the parent directories:

```bash
cd otel-v1 && ls -la src
# lrwxr-xr-x  src -> ../src

cd otel-v2 && ls -la src
# lrwxr-xr-x  src -> ../src
```

This means:

- ✅ We maintain one source of truth for the code
- ✅ Tests run against the same code but with different OTel versions
- ✅ No code duplication

### 3. Version Pinning

#### otel-v1/package.json

```json
{
  "devDependencies": {
    "@opentelemetry/api": "1.9.0",
    "@opentelemetry/core": "1.9.0",
    "@opentelemetry/sdk-trace-base": "1.9.0",
    "@opentelemetry/resources": "1.30.1",
    "@opentelemetry/exporter-trace-otlp-http": "0.57.2"
  }
}
```

#### otel-v2/package.json

```json
{
  "devDependencies": {
    "@opentelemetry/api": "1.9.0",
    "@opentelemetry/core": "^2.0.0",
    "@opentelemetry/sdk-trace-base": "2.0.0", // EXACT version, not ^2.0.0
    "@opentelemetry/resources": "2.0.0", // EXACT version, not ^2.0.0
    "@opentelemetry/exporter-trace-otlp-http": "^0.200.0"
  }
}
```

**⚠️ Critical: Version 2.1.0 has bugs**

- `@opentelemetry/resources@2.1.0` has a packaging bug where it references a missing `./detect-resources` module
- `@opentelemetry/sdk-trace-base@2.1.0` pulls in `@opentelemetry/resources@2.1.0` as a dependency
- **Solution**: Pin both packages to exactly `2.0.0` (without caret `^`) to prevent resolution to `2.1.0`

### 4. Workspace Isolation

**IMPORTANT**: These test packages MUST NOT be part of the pnpm workspace hoisting.

#### Why Isolation is Critical

If pnpm hoists dependencies, you get version conflicts:

```
sdk/node_modules/@opentelemetry/resources@2.1.0  ← Hoisted (broken)
  ↑
otel-v2/node_modules/@opentelemetry/resources@2.0.0  ← Should use this
```

Without isolation, Node.js may resolve to the hoisted version, breaking tests.

#### How Isolation Works

**Workspace Exclusions:**

Both the root and SDK workspace configurations explicitly exclude otel-v1 and otel-v2:

```yaml
# pnpm-workspace.yaml
packages:
  - "sdk/integrations/*"
  - "!sdk/integrations/otel-js/otel-v1" # Excluded
  - "!sdk/integrations/otel-js/otel-v2" # Excluded
```

This ensures these directories maintain their own isolated `node_modules/` and aren't subject to workspace hoisting.

**Local .npmrc Configuration:**

Each test directory has a `.npmrc` file with:

```
link-workspace-packages=false
```

This prevents pnpm from linking workspace packages when installing dependencies.

#### How to Install Dependencies

**For CI and automated testing:** Dependencies are handled automatically by the dedicated workflow (see CI Testing section below).

**For local development:**

Due to a pnpm quirk, you may need to "nudge" pnpm to create local `node_modules`:

```bash
cd otel-v2
rm -rf node_modules
pnpm add -D vitest  # Forces creation of local node_modules
```

After the initial setup, subsequent `pnpm install` commands will work correctly because the `.npmrc` and workspace exclusions are in place.

**Alternatively, use --ignore-workspace:**

```bash
cd otel-v2
pnpm install --ignore-workspace  # Forces isolated install
```

This is rarely needed but useful for troubleshooting or regenerating dependencies from scratch.

### 5. Vitest Configuration

Each test environment has a `vite.config.ts` that creates module aliases:

```typescript
import { defineConfig } from "vite-plus";
import {
  detectOtelVersion,
  logOtelVersions,
  createOtelAliases,
} from "../tests/utils";

const cwd = process.cwd();
const version = detectOtelVersion(cwd); // Detects "v1" or "v2" from path

logOtelVersions(version); // Logs installed versions for
debugging;

export default defineConfig({
  resolve:
    version !== "parent"
      ? {
          alias: createOtelAliases(cwd), // Force resolution to local node_modules
        }
      : {},
});
```

The `createOtelAliases()` function creates absolute path aliases:

```typescript
{
  "@opentelemetry/api": "/full/path/to/otel-v2/node_modules/@opentelemetry/api",
  "@opentelemetry/core": "/full/path/to/otel-v2/node_modules/@opentelemetry/core",
  "@opentelemetry/sdk-trace-base": "/full/path/to/otel-v2/node_modules/@opentelemetry/sdk-trace-base",
  "@opentelemetry/resources": "/full/path/to/otel-v2/node_modules/@opentelemetry/resources",
  // ... etc
}
```

This ensures vitest resolves OTel packages from the local test environment, not from hoisted workspace packages.

### 6. Cross-Version Compatibility Helpers

`tests/utils.ts` provides helpers that work across both OTel v1 and v2:

#### Example: createTracerProvider()

OpenTelemetry changed APIs between versions:

**v1.x API:**

```typescript
const provider = new BasicTracerProvider();
provider.addSpanProcessor(processor); // Method-based
```

**v2.x API:**

```typescript
const provider = new BasicTracerProvider({
  spanProcessors: [processor], // Constructor-based
});
```

**Our helper:**

```typescript
export function createTracerProvider(
  ProviderClass: any,
  processors: any[],
  config?: any,
): any {
  const testProvider = new ProviderClass(config || {});

  if (typeof testProvider.addSpanProcessor === "function") {
    // OTel 1.x path
    const provider = new ProviderClass(config);
    for (const processor of processors) {
      provider.addSpanProcessor(processor);
    }
    return provider;
  } else {
    // OTel 2.x path
    return new ProviderClass({
      ...config,
      spanProcessors: processors,
    });
  }
}
```

Tests use this helper to work seamlessly across both versions.

## Running Tests

### Test Both Versions

```bash
cd sdk/integrations/otel-js
pnpm test  # Runs both v1 and v2 tests
```

### Test Specific Version

```bash
cd sdk/integrations/otel-js
pnpm test:v1  # Only OTel 1.x tests
pnpm test:v2  # Only OTel 2.x tests
```

### Test Specific File in v2

```bash
cd otel-v2
pnpm test exporter.test.ts
```

## Troubleshooting

### Error: "Cannot find module 'braintrust' or its corresponding type declarations"

**Cause:** The `braintrust` peer dependency is not available during TypeScript declaration (`.d.ts`) build

**Solution:** The `braintrust` package must be added as a dev dependency in addition to being a peer dependency. This is already configured in `package.json`:

```json
{
  "devDependencies": {
    "braintrust": "workspace:*"
  },
  "peerDependencies": {
    "braintrust": ">=0.5.0"
  }
}
```

The workspace reference ensures the local `braintrust` SDK is available during builds while the peer dependency ensures consumers provide their own version.

### Error: "Cannot find module './detect-resources'"

**Cause:** `@opentelemetry/resources@2.1.0` is being used (it's broken)

**Solution:**

1. Check `otel-v2/package.json` has exact versions:
   ```json
   "@opentelemetry/sdk-trace-base": "2.0.0",
   "@opentelemetry/resources": "2.0.0"
   ```
2. Reinstall with isolation:
   ```bash
   cd otel-v2
   rm -rf node_modules
   pnpm install --ignore-workspace
   ```

### Error: "vitest: command not found"

**Cause:** Local `node_modules/` wasn't created (workspace hoisting was used)

**Solution:**

```bash
cd otel-v2
pnpm install --ignore-workspace
```

### Wrong OTel Version in Tests

Check the console output at test start:

```
=== OpenTelemetry Versions (v2) ===
  @opentelemetry/api: 1.9.0
  @opentelemetry/core: 2.0.0
  @opentelemetry/resources: 2.0.0  ← Should be 2.0.0, NOT 2.1.0
  @opentelemetry/sdk-trace-base: 2.0.0
===================================
```

If versions are wrong, reinstall with `--ignore-workspace`.

## Development Workflow

### Making Changes to Source Code

1. Edit files in `src/` (not in `otel-v1/src` or `otel-v2/src` - those are symlinks!)
2. Run tests in both environments:
   ```bash
   pnpm test
   ```

### Adding New Dependencies

**For main package:**

```bash
cd sdk/integrations/otel-js
pnpm add <package>
```

**For test environments (rare):**

```bash
cd otel-v1
pnpm add -D <package> --ignore-workspace
```

### Adding New Test Files

Test files should be added to `src/` and will automatically be available in both test environments via symlinks:

```bash
# Create test file in main src directory
touch src/my-new-feature.test.ts

# Now accessible from both:
ls otel-v1/src/my-new-feature.test.ts  # Via symlink
ls otel-v2/src/my-new-feature.test.ts  # Via symlink
```

## Why This Architecture?

1. **Version Compatibility**: OpenTelemetry has breaking changes between major versions
2. **Single Source of Truth**: Symlinks ensure we test the same code, not duplicates
3. **Isolation**: Separate `node_modules` prevents version conflicts
4. **CI/CD**: Tests verify compatibility with multiple OTel versions before publishing
5. **Real-world Testing**: Users may have either OTel v1.x or v2.x installed

## CI Testing

The otel-js package has a **dedicated CI workflow** separate from the main JavaScript SDK tests.

### Why a Separate Workflow?

1. **Unique isolation requirements**: otel-v1 and otel-v2 need isolated `node_modules`
2. **Special setup steps**: Requires "nudging" pnpm to create local dependencies
3. **Different failure modes**: OTel version conflicts shouldn't block other SDK tests
4. **Clearer test results**: Separate workflow makes it easier to identify OTel-specific issues

### CI Workflow: `.github/workflows/checks.yaml`

The consolidated `checks` workflow contains a dedicated `otel-js` job that:

1. **Builds isolated Docker images** for `otel-v1` and `otel-v2`
2. **Runs each image across Node 20 and 22**
3. **Keeps OTel-specific failures scoped to the `otel-js` job**

### Workflow Triggers

The workflow runs on:

- **Pull requests** that modify:
  - `integrations/otel-js/**`
  - `js/**` (braintrust SDK)
  - `.github/workflows/checks.yaml`
- **Pushes to main** that modify the same paths

### Matrix Testing

Tests run on:

- **Operating systems**: Ubuntu, Windows
- **Node versions**: 20, 22

### Checks Workflow Placement

OTel coverage now lives inside the consolidated `checks` workflow as its own job rather than in a separate workflow file.

### Makefile Targets

**For CI:**

```bash
make js-verify-checks    # Main hermetic checks workflow entrypoint
make js-test-otel-docker # Local equivalent for the Docker-based otel-js job
```

**For local development:**

```bash
cd integrations/otel-js
pnpm test           # Runs both v1 and v2 tests
pnpm test:v1        # Only OTel 1.x tests
pnpm test:v2        # Only OTel 2.x tests
```

**For Docker local development:**

```bash
# Build and run otel-v1 tests
docker build -f integrations/otel-js/Dockerfile.test --build-arg NODE_VERSION=22 --build-arg TEST_DIR=otel-v1 -t otel-js-test-v1 . && docker run --rm otel-js-test-v1

# Build and run otel-v2 tests
docker build -f integrations/otel-js/Dockerfile.test --build-arg NODE_VERSION=22 --build-arg TEST_DIR=otel-v2 -t otel-js-test-v2 . && docker run --rm otel-js-test-v2
```

## Related Files

- `package.json` - Main package definition and peer dependencies
- `tsup.config.ts` - Build configuration for the published package
- `tests/utils.ts` - Cross-version compatibility helpers
- `otel-v1/package.json` - OTel 1.x version constraints
- `otel-v1/.npmrc` - Isolation config for v1
- `otel-v2/package.json` - OTel 2.x version constraints
- `otel-v2/.npmrc` - Isolation config for v2
- `.github/workflows/checks.yaml` - Consolidated CI workflow
