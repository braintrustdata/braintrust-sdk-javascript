#!/bin/bash

# pull-vendor.sh
# Script to pull and manage local vendor repositories for development and LLM context
# These are kept local-only (git-ignored) for developer convenience

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the script directory (sdk/js/scripts)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
JS_DIR="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="vendor"
VENDOR_PATH="$JS_DIR/$VENDOR_DIR"

# Configuration
CLONE_DEPTH=1  # Minimal depth for smallest possible clones

# Function to show usage
show_usage() {
    echo "Usage: $0 <repo_url> <versions>"
    echo ""
    echo "Arguments:"
    echo "  repo_url   - GitHub repository URL (e.g., https://github.com/vercel/ai.git)"
    echo "  versions   - Comma-separated list of major versions to track (e.g., v3,v4,v5)"
    echo ""
    echo "Examples:"
    echo "  $0 https://github.com/vercel/ai.git v4,v5,v6,v7"
    echo "  $0 https://github.com/openai/openai-node.git v3,v4"
    echo "  $0 https://github.com/anthropics/anthropic-sdk-typescript.git v0.20,v0.21"
    echo ""
    echo "The script will:"
    echo "  - Shallow clone each version to vendor/<org>-<repo>-<version>/"
    echo "  - Checkout the latest tag within each major version"
    echo "  - Keep everything local-only (git-ignored)"
    echo "  - Use minimal disk space with shallow clones"
    exit 1
}

# Check arguments
if [ $# -ne 2 ]; then
    show_usage
fi

REPO_URL=$1
VERSIONS=$2

# Extract repo name from URL
# Handle both .git and non-.git endings
REPO_NAME=$(basename "$REPO_URL" .git)
# Also extract the org name for clarity
REPO_ORG=$(echo "$REPO_URL" | sed -E 's#.*/([^/]+)/[^/]+$#\1#')
FULL_REPO_NAME="${REPO_ORG}-${REPO_NAME}"

echo -e "${BLUE}Pulling vendor repositories for ${REPO_ORG}/${REPO_NAME}${NC}"
echo -e "${BLUE}Versions: ${VERSIONS}${NC}"
echo -e "${BLUE}Vendor path: ${VENDOR_PATH}${NC}"
echo -e "${BLUE}Clone depth: ${CLONE_DEPTH} (shallow for efficiency)${NC}"

# Create vendor directory if it doesn't exist
if [ ! -d "$VENDOR_PATH" ]; then
    echo -e "${YELLOW}Creating vendor directory...${NC}"
    mkdir -p "$VENDOR_PATH"
fi

# Function to get the latest tag for a major version
get_latest_tag_for_major() {
    local version_prefix=$1
    local repo_dir=$2

    cd "$repo_dir"

    # Fetch tags (shallow fetch)
    git fetch --tags --depth=1 --quiet 2>/dev/null || true

    # Handle different version patterns
    # Try exact prefix match first (e.g., v3.*)
    latest_tag=$(git tag -l "${version_prefix}.*" | sort -V | tail -n 1)

    # If no results and version starts with 'v', try without 'v'
    if [ -z "$latest_tag" ] && [[ "$version_prefix" == v* ]]; then
        version_without_v="${version_prefix#v}"
        latest_tag=$(git tag -l "${version_without_v}.*" | sort -V | tail -n 1)
    fi

    # If still no results and version doesn't start with 'v', try with 'v'
    if [ -z "$latest_tag" ] && [[ "$version_prefix" != v* ]]; then
        latest_tag=$(git tag -l "v${version_prefix}.*" | sort -V | tail -n 1)
    fi

    # Special case for vercel/ai which uses ai@X.Y.Z format
    if [ -z "$latest_tag" ] && [[ "$REPO_NAME" == "ai" ]]; then
        # Strip 'v' if present
        clean_version="${version_prefix#v}"
        latest_tag=$(git tag -l "ai@${clean_version}.*" | sort -V | tail -n 1)
    fi

    echo "$latest_tag"
}

# Function to clone or update a specific version
update_version() {
    local version=$1
    local version_dir="$VENDOR_PATH/$FULL_REPO_NAME-$version"

    echo -e "\n${BLUE}Processing $version...${NC}"

    if [ ! -d "$version_dir" ]; then
        echo -e "${YELLOW}Shallow cloning repository for $version (depth=${CLONE_DEPTH})...${NC}"
        # Use shallow clone with limited depth
        git clone --depth "$CLONE_DEPTH" --quiet "$REPO_URL" "$version_dir" 2>/dev/null || {
            echo -e "${RED}Failed to clone repository${NC}"
            return 1
        }
    else
        echo -e "${GREEN}Repository for $version already exists${NC}"
        # Update the shallow clone
        cd "$version_dir"
        echo -e "${YELLOW}Fetching latest changes (shallow)...${NC}"
        git fetch --depth "$CLONE_DEPTH" --quiet 2>/dev/null || true
    fi

    # Get the latest tag for this version
    latest_tag=$(get_latest_tag_for_major "$version" "$version_dir")

    if [ -z "$latest_tag" ]; then
        echo -e "${RED}No tags found matching $version pattern${NC}"
        echo -e "${YELLOW}Showing sample of available tags:${NC}"
        cd "$version_dir"
        git tag | head -10
        return 0
    fi

    cd "$version_dir"

    # Check if we need to fetch the specific tag
    if ! git rev-parse "$latest_tag" >/dev/null 2>&1; then
        echo -e "${YELLOW}Fetching tag $latest_tag...${NC}"
        git fetch --depth=1 origin "refs/tags/${latest_tag}:refs/tags/${latest_tag}" --quiet 2>/dev/null || {
            echo -e "${RED}Failed to fetch tag $latest_tag${NC}"
            return 1
        }
    fi

    # Get current checked out tag/commit
    current_ref=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo "unknown")

    if [ "$current_ref" == "$latest_tag" ]; then
        echo -e "${GREEN}Already on latest tag: $latest_tag${NC}"
    else
        echo -e "${YELLOW}Updating from $current_ref to $latest_tag...${NC}"
        git checkout --quiet "$latest_tag" 2>/dev/null || {
            echo -e "${RED}Failed to checkout $latest_tag${NC}"
            return 1
        }
        echo -e "${GREEN}Successfully checked out $latest_tag${NC}"
    fi

    # Show some useful info
    echo -e "  Path: ${version_dir#$JS_DIR/}"
    echo -e "  Tag: $latest_tag"
    echo -e "  Date: $(git log -1 --format=%cd --date=short 2>/dev/null || echo 'unknown')"

    # Show repository size
    repo_size=$(du -sh "$version_dir" 2>/dev/null | cut -f1)
    echo -e "  Size: $repo_size (shallow clone)"
}

# Function to check for newer major versions
check_future_versions() {
    echo -e "\n${BLUE}Checking for additional major versions...${NC}"

    # Create a temporary shallow clone just for checking tags
    local temp_dir=$(mktemp -d)

    git clone --depth 1 --no-checkout --quiet "$REPO_URL" "$temp_dir" 2>/dev/null || {
        echo -e "${RED}Failed to check for new versions${NC}"
        rm -rf "$temp_dir"
        return 0
    }

    cd "$temp_dir"
    git fetch --tags --depth=1 --quiet 2>/dev/null || true

    # Get all major versions (both v-prefixed and non-prefixed)
    all_majors=$(git tag -l | grep -E '^v?[0-9]+\.' | sed -E 's/^(v?[0-9]+)\..*/\1/' | sort -u)

    # Special case for vercel/ai
    if [[ "$REPO_NAME" == "ai" ]]; then
        ai_majors=$(git tag -l "ai@*" | sed -E 's/^ai@([0-9]+)\..*/v\1/' | sort -u)
        all_majors=$(echo -e "$all_majors\n$ai_majors" | sort -u)
    fi

    # Clean up temp directory
    cd - > /dev/null
    rm -rf "$temp_dir"

    # Convert input versions to array
    IFS=',' read -ra INPUT_VERSIONS <<< "$VERSIONS"

    # Check for versions we don't have in our list
    local found_new=0
    for major in $all_majors; do
        local is_tracked=0
        for input_version in "${INPUT_VERSIONS[@]}"; do
            # Normalize comparison (handle v-prefix variations)
            input_clean=$(echo "$input_version" | sed 's/^v//' | tr -d ' ')
            major_clean=$(echo "$major" | sed 's/^v//')
            if [ "$input_clean" == "$major_clean" ]; then
                is_tracked=1
                break
            fi
        done

        if [ $is_tracked -eq 0 ] && [ -n "$major" ]; then
            if [ $found_new -eq 0 ]; then
                echo -e "${YELLOW}Additional major versions available:${NC}"
                found_new=1
            fi
            echo -e "  - $major"
        fi
    done

    if [ $found_new -eq 1 ]; then
        echo -e "${YELLOW}Add these to your version list if needed${NC}"
    fi
}

# Main execution
echo -e "${GREEN}Starting vendor repository pull...${NC}"

# Convert comma-separated versions to array
IFS=',' read -ra VERSION_ARRAY <<< "$VERSIONS"

# Process each version
for version in "${VERSION_ARRAY[@]}"; do
    # Trim whitespace
    version=$(echo "$version" | tr -d ' ')
    update_version "$version"
done

# Check for future versions
check_future_versions

echo -e "\n${GREEN}✅ Vendor repository pull complete!${NC}"
echo -e "${BLUE}Vendor libraries are available in: $VENDOR_DIR/${NC}"
echo -e "${BLUE}These directories are git-ignored and local-only.${NC}"

# Create or update README in vendor directory
cat > "$VENDOR_PATH/README.md" << EOF
# Vendor Libraries (Local Only)

This directory contains local shallow clones of vendor libraries for development and LLM context.
These are **NOT** committed to the repository and are developer-specific.

## Current Libraries

### ${REPO_ORG}/${REPO_NAME}

Repository: ${REPO_URL}
Tracked versions: ${VERSIONS}

Directories:
EOF

# Add directory listing to README
for version in "${VERSION_ARRAY[@]}"; do
    version=$(echo "$version" | tr -d ' ')
    echo "- \`${FULL_REPO_NAME}-${version}/\` - Latest ${version}.x release" >> "$VENDOR_PATH/README.md"
done

cat >> "$VENDOR_PATH/README.md" << 'EOF'

## Updating

Run the pull script to update to the latest tags:

```bash
cd sdk/js

# Example for vercel/ai (uses ai@X.Y.Z tag format)
./scripts/pull-vendor.sh https://github.com/vercel/ai.git v4,v5,v6,v7

# Example for OpenAI SDK
./scripts/pull-vendor.sh https://github.com/openai/openai-node.git v3,v4

# Example for Anthropic SDK
./scripts/pull-vendor.sh https://github.com/anthropics/anthropic-sdk-typescript.git v0.20,v0.21,v0.22

# Example for Langchain
./scripts/pull-vendor.sh https://github.com/langchain-ai/langchainjs.git v0.1,v0.2,v0.3
```

## Why Local Vendor Libraries?

These vendor libraries serve as:
1. **Reference implementations** for our SDK development
2. **Context for LLMs** when working with integrations
3. **Quick access** to different API versions without switching branches
4. **Minimal disk usage** through shallow clones

## Technical Details

- Uses shallow clones (depth=10) to minimize disk space
- Automatically finds the latest tag within each major version
- Repositories are cloned once and then updated on subsequent runs
- All vendor directories are git-ignored and remain local-only
- Supports various tag formats (v1.2.3, 1.2.3, ai@1.2.3, etc.)

## Adding to .gitignore

The `vendor/` directory is already added to `.gitignore`. If you need to verify:

```bash
grep "vendor/" sdk/js/.gitignore
```

## Cleaning Up

To remove all vendor libraries and free up disk space:

```bash
cd sdk/js
rm -rf vendor/
```
EOF

echo -e "\n${BLUE}To update these repositories in the future:${NC}"
echo -e "  cd $JS_DIR"
echo -e "  ./scripts/pull-vendor.sh $REPO_URL $VERSIONS"

# Show total vendor directory size
if [ -d "$VENDOR_PATH" ]; then
    total_size=$(du -sh "$VENDOR_PATH" 2>/dev/null | cut -f1)
    echo -e "\n${BLUE}Total vendor directory size: ${total_size}${NC}"
fi
