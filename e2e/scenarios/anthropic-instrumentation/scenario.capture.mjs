import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAttachmentCaptureScenario } from "../../helpers/attachment-capture-scenario.mjs";

runMain(async () =>
  runAttachmentCaptureScenario(
    "anthropic",
    import.meta.url,
    await import(process.env.CAPTURE_PACKAGE_NAME),
  ),
);
