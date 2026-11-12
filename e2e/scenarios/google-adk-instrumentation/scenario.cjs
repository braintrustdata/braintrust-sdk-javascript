const adk = require(
  process.env.GOOGLE_ADK_PACKAGE_NAME ?? "google-adk-sdk-v2-latest",
);

async function main() {
  const { runMain } = await import("../../helpers/provider-runtime.mjs");
  const { runAutoGoogleADKInstrumentation } =
    await import("./scenario.impl.mjs");
  runMain(async () => runAutoGoogleADKInstrumentation(adk));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
