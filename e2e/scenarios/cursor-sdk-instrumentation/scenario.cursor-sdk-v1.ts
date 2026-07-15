const packageName =
  process.env.CURSOR_SDK_PACKAGE_NAME ?? "cursor-sdk-v1-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedCursorSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const cursorSDK = await import(packageName);
  await runWrappedCursorSDKInstrumentation(cursorSDK);
});
