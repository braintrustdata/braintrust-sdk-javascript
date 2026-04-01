## Discover integration scenarios under ../../integrations
SCRIPTDIR := ../../integrations
LOCAL_MAKEFILES := $(shell find scenarios -type f -path 'scenarios/*/Makefile' -not -path '*/node_modules/*' 2>/dev/null)
INTEGRATION_MAKEFILES := $(shell find $(SCRIPTDIR) -type f -path '*/smoke/scenarios/*/Makefile' -not -path '*/node_modules/*' 2>/dev/null)
SCENARIO_MAKEFILES := $(LOCAL_MAKEFILES) $(INTEGRATION_MAKEFILES)
LOCAL_SCENARIOS := $(patsubst scenarios/%/Makefile,%,$(LOCAL_MAKEFILES))
INTEGRATION_SCENARIOS := $(shell echo "$(INTEGRATION_MAKEFILES)" | tr ' ' '\n' | sed 's|$(SCRIPTDIR)/||' | sed 's|/smoke/scenarios/|/|' | sed 's|/Makefile$$||' | tr '\n' ' ')
SCENARIOS := $(LOCAL_SCENARIOS) $(INTEGRATION_SCENARIOS)

.PHONY: help setup test list clean discover

# Declare all scenarios as phony targets with empty recipes
# This prevents "No rule to make target" errors when running: make test scenario-name
.PHONY: $(LOCAL_SCENARIOS) $(INTEGRATION_SCENARIOS)
$(LOCAL_SCENARIOS) $(INTEGRATION_SCENARIOS):
	@: # Empty recipe - actual test logic is in the test target

## ============================================================================
## Help
## ============================================================================

help:
	@echo "Smoke Test Infrastructure"
	@echo ""
	@echo "Available targets:"
	@echo "  make test                - Run all discovered integration scenarios"
	@echo "  make test <integration/name> - Run specific scenario (e.g., make test templates-nunjucks/basic-render)"
	@echo "  make setup               - Ensure SDK artifacts + shared package are ready"
	@echo "  make clean               - Remove all build artifacts (force rebuild)"
	@echo "  make list                - List discovered scenarios"
	@echo ""
	@echo "Environment variables:"
	@echo "  BRAINTRUST_TAR           - Path to braintrust tarball (auto-set by parent when running locally)"
	@echo "  BRAINTRUST_BROWSER_TAR   - Path to browser tarball (auto-set by parent when running locally)"
	@echo "  BRAINTRUST_OTEL_TAR      - Path to otel tarball (auto-set by parent when running locally)"
	@echo "  SMOKE_V2_SHARED_DIST     - Path to shared package dist (auto-set by parent when running locally)"
	@echo ""
	@echo "Discovered local scenarios:"; \
	for s in $(LOCAL_SCENARIOS); do \
		if [ -n "$$s" ]; then echo "  - $$s"; fi; \
	done; \
	echo "Discovered integration scenarios:"; \
	for s in $(INTEGRATION_SCENARIOS); do \
		if [ -n "$$s" ]; then echo "  - $$s"; fi; \
	done

## ============================================================================
## Setup - Build SDK + shared package
## ============================================================================

setup:
	@echo "==> Setting up smoke"
	@mkdir -p ../artifacts

	@# Build SDK and create tarball if not provided
	@if [ -n "$(BRAINTRUST_TAR)" ] && [ -f "$(BRAINTRUST_TAR)" ]; then \
		echo "==> Using provided BRAINTRUST_TAR: $(BRAINTRUST_TAR)"; \
	else \
		echo "==> Building SDK and creating tarball"; \
		cd ../../.. && pnpm exec turbo build --filter=braintrust && pnpm --filter=braintrust pack --pack-destination sdk/js/artifacts; \
		for f in sdk/js/artifacts/braintrust-*.tgz; do \
			if [ "$$(basename $$f)" != "braintrust-latest.tgz" ] && [ "$$(basename $$f)" != "braintrust-otel-latest.tgz" ] && [ "$$(basename $$f)" != "braintrust-browser-latest.tgz" ]; then \
				cp "$$f" sdk/js/artifacts/braintrust-latest.tgz; \
				break; \
			fi; \
		done; \
	fi

	@# Build browser package and create tarball if not provided
	@if [ -n "$(BRAINTRUST_BROWSER_TAR)" ] && [ -f "$(BRAINTRUST_BROWSER_TAR)" ]; then \
		echo "==> Using provided BRAINTRUST_BROWSER_TAR: $(BRAINTRUST_BROWSER_TAR)"; \
	else \
		echo "==> Building browser package and creating tarball"; \
		cd ../../.. && pnpm exec turbo build --filter=@braintrust/browser && pnpm --filter=@braintrust/browser pack --pack-destination sdk/js/artifacts; \
		for f in sdk/js/artifacts/braintrust-browser-*.tgz; do \
			if [ "$$(basename $$f)" != "braintrust-browser-latest.tgz" ]; then \
				cp "$$f" sdk/js/artifacts/braintrust-browser-latest.tgz; \
				break; \
			fi; \
		done; \
	fi

	@# Build shared package if not provided
	@if [ -n "$(SMOKE_V2_SHARED_DIST)" ] && [ -d "$(SMOKE_V2_SHARED_DIST)" ]; then \
		echo "==> Using provided SMOKE_V2_SHARED_DIST: $(SMOKE_V2_SHARED_DIST)"; \
	else \
		if [ ! -d shared/dist ]; then \
			echo "==> Building shared package"; \
			cd shared && pnpm install --ignore-workspace --frozen-lockfile && pnpm run build; \
		else \
			echo "==> Shared package already built"; \
		fi; \
	fi

## ============================================================================
## Clean - Remove all build artifacts
## ============================================================================

clean:
	@echo "==> Cleaning smoke artifacts"
	rm -rf ../artifacts/*.tgz
	rm -rf shared/dist shared/node_modules

## ============================================================================
## Test - Run scenarios
## ============================================================================

# Support positional scenario argument: make test integration/name


test:
	@# Collect requested scenario names (strip any trailing /Makefile if provided by user)
	@REQUESTED_RAW="$(filter-out test,$(MAKECMDGOALS))"; \
	REQUESTED="$$(echo $$REQUESTED_RAW | tr ' ' '\n' | sed 's|/Makefile$$||' | tr '\n' ' ' | xargs)"; \
	if [ -z "$$REQUESTED" ]; then \
		SCENARIOS_TO_RUN="$(SCENARIOS)"; \
		echo "==> Running all discovered scenarios"; \
	else \
		SCENARIOS_TO_RUN=""; \
		for scenario in $$REQUESTED; do \
			if echo "$$scenario" | grep -q '/'; then \
				integration=$$(echo $$scenario | cut -d/ -f1); \
				name=$$(echo $$scenario | cut -d/ -f2-); \
				dir="$(SCRIPTDIR)/$$integration/smoke/scenarios/$$name"; \
			else \
				dir="scenarios/$$scenario"; \
			fi; \
			if [ ! -d "$$dir" ]; then \
				echo "Error: Scenario '$$scenario' not found at $$dir"; \
				echo "Available scenarios:"; \
				for s in $(LOCAL_SCENARIOS) $(INTEGRATION_SCENARIOS); do \
					echo "  - $$s"; \
				done; \
				exit 1; \
			fi; \
			SCENARIOS_TO_RUN="$$SCENARIOS_TO_RUN $$dir"; \
		done; \
		echo "==> Running scenarios: $$REQUESTED"; \
	fi; \
	\
	$(MAKE) setup; \
	\
	: $${BRAINTRUST_TAR:=../artifacts/braintrust-latest.tgz}; \
	: $${BRAINTRUST_BROWSER_TAR:=../artifacts/braintrust-browser-latest.tgz}; \
	: $${BRAINTRUST_OTEL_TAR:=../artifacts/braintrust-otel-latest.tgz}; \
	: $${SMOKE_V2_SHARED_DIST:=shared/dist}; \
	export BRAINTRUST_TAR BRAINTRUST_BROWSER_TAR BRAINTRUST_OTEL_TAR SMOKE_V2_SHARED_DIST; \
	\
	FAILED_SCENARIOS=""; \
	for scenario in $$SCENARIOS_TO_RUN; do \
		echo ""; \
		echo "=== Testing $$scenario ==="; \
		if [ -f "$$scenario/Makefile" ]; then \
			if ! $(MAKE) -C $$scenario test; then \
				FAILED_SCENARIOS="$$FAILED_SCENARIOS $$(echo $$scenario | sed 's|$(SCRIPTDIR)/||' | sed 's|/scenarios/|/|')"; \
			fi; \
		elif [ -f "$$scenario/test.js" ]; then \
			( cd $$scenario && node test.js ) || FAILED_SCENARIOS="$$FAILED_SCENARIOS $$(echo $$scenario | sed 's|$(SCRIPTDIR)/||' | sed 's|/scenarios/|/|')"; \
		else \
			FAILED_SCENARIOS="$$FAILED_SCENARIOS $$(echo $$scenario | sed 's|$(SCRIPTDIR)/||' | sed 's|/scenarios/|/|')"; \
		fi; \
	done; \
	\
	echo ""; \
	if [ -n "$$FAILED_SCENARIOS" ]; then \
		echo "✗ Failed scenarios:$$FAILED_SCENARIOS"; \
		exit 1; \
	else \
		echo "✓ All requested scenarios passed"; \
	fi

## ============================================================================
## List - Show discovered scenarios
## ============================================================================

list:
	@echo "Discovered scenarios:"; \
	for s in $(SCENARIOS); do echo "  - $$s"; done
	@echo ''
