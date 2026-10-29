#!/bin/sh
set -e

pnpm install --ignore-workspace
pnpm exec vp test run
