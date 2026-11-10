#!/bin/sh
set -e

pnpm install --ignore-workspace
pnpm run check:typings
pnpm exec vp test run
