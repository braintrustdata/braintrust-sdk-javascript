#!/bin/sh
set -e

pnpm install --ignore-workspace --frozen-lockfile
pnpm run check:typings
pnpm exec vp test run
