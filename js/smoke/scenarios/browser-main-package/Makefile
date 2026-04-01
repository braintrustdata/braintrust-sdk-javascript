.PHONY: install build test clean

install:
	pnpm install --ignore-workspace --lockfile=false
	pnpm exec playwright install --with-deps chromium

build: install
	node esbuild.config.mjs

test: build
	pnpm exec playwright test

clean:
	rm -rf node_modules dist
