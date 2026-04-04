import {
  DOCS_HOMEPAGE,
  GITHUB_REPO_URL,
  PRIVATE_WORKSPACE_PACKAGES,
  PUBLISHABLE_PACKAGES,
  listWorkspacePackageDirs,
  readPackage,
} from "./_shared.mjs";

const errors = [];
const warnings = [];

const workspaceDirs = new Set(listWorkspacePackageDirs());
const approvedPublishableDirs = new Set(
  PUBLISHABLE_PACKAGES.map((pkg) => pkg.dir),
);
const approvedPrivateDirs = new Set(
  PRIVATE_WORKSPACE_PACKAGES.map((pkg) => pkg.dir),
);

for (const expected of [
  ...PUBLISHABLE_PACKAGES,
  ...PRIVATE_WORKSPACE_PACKAGES,
]) {
  if (!workspaceDirs.has(expected.dir)) {
    errors.push(
      `${expected.dir} is missing from the pnpm workspace discovery set derived from pnpm-workspace.yaml`,
    );
  }
}

for (const workspaceDir of workspaceDirs) {
  const manifest = readPackage(workspaceDir);

  if (approvedPublishableDirs.has(workspaceDir)) {
    validatePublishablePackage(workspaceDir, manifest);
    continue;
  }

  if (approvedPrivateDirs.has(workspaceDir)) {
    if (manifest.private !== true) {
      errors.push(`${workspaceDir} (${manifest.name}) must remain private`);
    }
    continue;
  }

  if (manifest.private !== true) {
    errors.push(
      `${workspaceDir} (${manifest.name}) is a workspace package but is not on the publish allowlist and is not private`,
    );
  }
}

if (errors.length > 0) {
  console.error("Publishable package validation failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  if (warnings.length > 0) {
    console.error("\nWarnings:");
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }
  process.exit(1);
}

console.log(
  `Validated ${PUBLISHABLE_PACKAGES.length} publishable packages and ${PRIVATE_WORKSPACE_PACKAGES.length} private workspace packages.`,
);
if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

function validatePublishablePackage(workspaceDir, manifest) {
  const approved = PUBLISHABLE_PACKAGES.find((pkg) => pkg.dir === workspaceDir);
  if (!approved) {
    errors.push(`No publishable package mapping found for ${workspaceDir}`);
    return;
  }

  if (manifest.name !== approved.name) {
    errors.push(
      `${workspaceDir} has package name ${manifest.name}, expected ${approved.name}`,
    );
  }

  if (manifest.private === true) {
    errors.push(`${workspaceDir} (${manifest.name}) must not be private`);
  }

  if (manifest.publishConfig?.access !== "public") {
    errors.push(
      `${workspaceDir} (${manifest.name}) must set publishConfig.access to public`,
    );
  }

  if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
    errors.push(
      `${workspaceDir} (${manifest.name}) must set publishConfig.registry to https://registry.npmjs.org/`,
    );
  }

  if (manifest.repository?.url !== GITHUB_REPO_URL) {
    errors.push(
      `${workspaceDir} (${manifest.name}) must point repository.url at ${GITHUB_REPO_URL}`,
    );
  }

  if (manifest.repository?.directory !== workspaceDir) {
    errors.push(
      `${workspaceDir} (${manifest.name}) must set repository.directory to ${workspaceDir}`,
    );
  }

  if (manifest.homepage !== DOCS_HOMEPAGE) {
    warnings.push(
      `${workspaceDir} (${manifest.name}) homepage should be ${DOCS_HOMEPAGE}`,
    );
  }

  if (!manifest.license) {
    errors.push(`${workspaceDir} (${manifest.name}) must declare a license`);
  }
}
