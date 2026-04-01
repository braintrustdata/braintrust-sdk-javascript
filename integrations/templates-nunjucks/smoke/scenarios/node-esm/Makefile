.PHONY: setup test

# ============================================================================
# Setup
# ============================================================================

setup:
	@echo "==> Setting up templates-nunjucks scenario"
	mise install

	@# Check if BRAINTRUST_TAR is set (from parent or CI), otherwise build
	@if [ -n "$(BRAINTRUST_TAR)" ]; then \
		echo "==> Using BRAINTRUST_TAR: $(BRAINTRUST_TAR)"; \
	else \
		echo "==> Building SDK"; \
		cd ../../../../.. && pnpm exec turbo build --filter=braintrust && mkdir -p js/artifacts && pnpm --filter=braintrust pack --pack-destination js/artifacts; \
		for f in js/artifacts/braintrust-*.tgz; do \
			if [ "$$(basename $$f)" != "braintrust-latest.tgz" ] && \
			   [ "$$(basename $$f)" != "braintrust-otel-latest.tgz" ] && \
			   [ "$$(basename $$f)" != "braintrust-templates-nunjucks-latest.tgz" ]; then \
				cp "$$f" js/artifacts/braintrust-latest.tgz; \
				break; \
			fi; \
		done; \
	fi

	@# Build shared package (if not running from parent)
	@if [ -z "$(SMOKE_V2_SHARED_DIST)" ]; then \
		echo "==> Building shared package"; \
		cd ../../../../../js/smoke/shared && pnpm install --ignore-workspace --frozen-lockfile && pnpm run build; \
	fi

	@# Build @braintrust/templates-nunjucks-js package into js/artifacts
	@if [ -n "$(BRAINTRUST_TEMPLATES_NUNJUCKS_JS_TAR)" ]; then \
		echo "==> Using BRAINTRUST_TEMPLATES_NUNJUCKS_JS_TAR: $(BRAINTRUST_TEMPLATES_NUNJUCKS_JS_TAR)"; \
	else \
		echo "==> Building @braintrust/templates-nunjucks-js package"; \
		cd ../../../../.. && pnpm exec turbo build --filter=@braintrust/templates-nunjucks-js && cd integrations/templates-nunjucks && pnpm pack --pack-destination ../js/artifacts; \
		for f in ../../js/artifacts/braintrust-templates-nunjucks-*.tgz; do \
			if [ "$$(basename $$f)" != "braintrust-templates-nunjucks-js-latest.tgz" ]; then \
				cp "$$f" ../../js/artifacts/braintrust-templates-nunjucks-js-latest.tgz; \
				break; \
			fi; \
		done; \
	fi

	pnpm install --ignore-workspace --lockfile=false

# ============================================================================
# Test
# ============================================================================

test: setup
	@echo "==> Running templates-nunjucks tests"
	pnpm exec tsx tests/basic.test.ts
