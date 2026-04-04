#!/usr/bin/env bash
set -euo pipefail

RELEASE_MANIFEST="${1:-${RELEASE_MANIFEST:-}}"

if [[ -n "$RELEASE_MANIFEST" && -f "$RELEASE_MANIFEST" ]]; then
  mapfile -t PACKAGES < <(node -e 'const fs = require("fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const pkg of manifest.packages || []) console.log(pkg.name);' "$RELEASE_MANIFEST")
else
  mapfile -t PACKAGES < <(node -e 'import("./_shared.mjs").then(m => m.PUBLISHABLE_PACKAGE_NAMES.forEach(n => console.log(n)));')
fi

if [[ ${#PACKAGES[@]} -eq 0 ]]; then
  echo "No publishable packages selected for build."
  exit 0
fi

ARGS=()
for package in "${PACKAGES[@]}"; do
  ARGS+=("--filter=${package}")
done

pnpm exec turbo run build "${ARGS[@]}"
