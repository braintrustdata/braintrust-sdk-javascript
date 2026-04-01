.PHONY: setup test

setup:
	@echo "==> Setting up templates-nunjucks deno scenario"
	mise install

	@# Build or extract braintrust SDK (workspace link will use dist/)
	@if [ -n "$(BRAINTRUST_TAR)" ]; then \
		echo "==> Extracting SDK tarball for workspace link"; \
		TARBALL_PATH="$$(cd ../../../../../js/smoke && pwd)/$(BRAINTRUST_TAR)"; \
		echo "==> Resolved tarball path: $$TARBALL_PATH"; \
		cd ../../../../../js && tar -xzf "$$TARBALL_PATH" --strip-components=1 package/dist; \
	else \
		echo "==> Building SDK"; \
		cd ../../../../../js && pnpm build; \
	fi

	@# Build or extract @braintrust/templates-nunjucks-js (workspace link will use dist/)
	@if [ -n "$(BRAINTRUST_TEMPLATES_NUNJUCKS_JS_TAR)" ]; then \
		echo "==> Extracting templates-nunjucks tarball for workspace link"; \
		TARBALL_PATH="$$(cd ../../../../../js/smoke && pwd)/$(BRAINTRUST_TEMPLATES_NUNJUCKS_JS_TAR)"; \
		echo "==> Resolved tarball path: $$TARBALL_PATH"; \
		cd ../../.. && tar -xzf "$$TARBALL_PATH" --strip-components=1 package/dist; \
	else \
		echo "==> Building @braintrust/templates-nunjucks-js package"; \
		cd ../../../../.. && pnpm install && pnpm --filter=@braintrust/templates-nunjucks-js build; \
	fi

	@# Build shared package (if not running from parent)
	@if [ -z "$(SMOKE_V2_SHARED_DIST)" ]; then \
		echo "==> Building shared package"; \
		cd ../../../../../js/smoke/shared && pnpm install --ignore-workspace --frozen-lockfile && pnpm run build; \
	fi

test: setup
	@echo "==> Running deno tests"
	mise exec -- deno test --no-check --sloppy-imports --allow-all tests/*.test.ts
