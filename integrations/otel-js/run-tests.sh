#!/bin/sh
set -e

pnpm install --ignore-workspace --frozen-lockfile
pnpm exec vitest run
