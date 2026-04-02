.PHONY: setup test

setup:
	@echo "==> Setting up cloudflare-vite-hono-vite-dev"
	mise install
	@# Check if BRAINTRUST_TAR is set (from parent or CI), otherwise build
	@if [ -n "$(BRAINTRUST_TAR)" ]; then \
		echo "==> Using BRAINTRUST_TAR: $(BRAINTRUST_TAR)"; \
	else \
		echo "==> Building SDK"; \
		cd ../../.. && pnpm exec turbo build --filter=braintrust && mkdir -p artifacts && pnpm pack --pack-destination artifacts; \
		\
		for f in artifacts/braintrust-*.tgz; do \
			[ "$$(basename $$f)" = "braintrust-latest.tgz" ] && continue; \
			cp "$$f" artifacts/braintrust-latest.tgz; \
			break; \
		done; \
	fi
	@# Build shared package (if not running from parent)
	@if [ -z "$(SMOKE_V2_SHARED_DIST)" ]; then \
		echo "==> Building shared package"; \
		cd ../../shared && pnpm install --ignore-workspace --frozen-lockfile && pnpm run build; \
	fi
	pnpm install --ignore-workspace --lockfile=false

test: setup
	@echo "==> Running cloudflare-vite-hono-vite-dev test"
	@pnpm exec tsx tests/vite-dev.test.mjs
