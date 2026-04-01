.PHONY: setup test

# =============================================================================
# Setup
# =============================================================================

setup:
	@echo "==> Setting up otel-v1 scenario"
	mise install

	@# Check if BRAINTRUST_TAR is set (from parent or CI), otherwise build
	@if [ -n "$(BRAINTRUST_TAR)" ]; then \
		echo "==> Using BRAINTRUST_TAR: $(BRAINTRUST_TAR)"; \
	else \
		echo "==> Building SDK"; \
		cd ../../../.. && pnpm exec turbo build --filter=braintrust && mkdir -p artifacts && pnpm pack --pack-destination artifacts; \
		\
		for f in artifacts/braintrust-*.tgz; do \
			if [ "$$(basename $$f)" != "braintrust-latest.tgz" ] && \
			   [ "$$(basename $$f)" != "braintrust-otel-latest.tgz" ]; then \
				cp "$$f" artifacts/braintrust-latest.tgz; \
				break; \
			fi; \
		done; \
	fi

	@# Build shared package (if not running from parent)
	@if [ -z "$(SMOKE_V2_SHARED_DIST)" ]; then \
		echo "==> Building shared package"; \
		cd ../../../shared && pnpm install --ignore-workspace --frozen-lockfile && pnpm run build; \
	fi

	@# Check if BRAINTRUST_OTEL_TAR is set (from parent or CI), otherwise build
	@if [ -n "$(BRAINTRUST_OTEL_TAR)" ]; then \
		echo "==> Using BRAINTRUST_OTEL_TAR: $(BRAINTRUST_OTEL_TAR)"; \
	else \
		echo "==> Building @braintrust/otel package"; \
		cd ../../../../../integrations/otel-js && pnpm exec turbo build --filter=@braintrust/otel && pnpm pack --pack-destination ../../js/artifacts; \
		\
		for f in ../../../js/artifacts/braintrust-otel-*.tgz; do \
			if [ "$$(basename $$f)" != "braintrust-otel-latest.tgz" ]; then \
				cp "$$f" ../../../js/artifacts/braintrust-otel-latest.tgz; \
				break; \
			fi; \
		done; \
	fi

	pnpm install --ignore-workspace --lockfile=false

# =============================================================================
# Test
# =============================================================================

test: setup
	@echo "==> Running otel-v1 tests"
	@FAILED=0; \
	pnpm exec tsx tests/basic.test.ts || FAILED=1; \
	pnpm exec tsx tests/filtering.test.ts || FAILED=1; \
	pnpm exec tsx tests/shared-suite.test.ts || FAILED=1; \
	exit $$FAILED
