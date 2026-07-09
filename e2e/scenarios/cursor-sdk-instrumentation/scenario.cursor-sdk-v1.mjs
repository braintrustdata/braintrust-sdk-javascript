const packageName =
  process.env.CURSOR_SDK_PACKAGE_NAME ?? "cursor-sdk-v1-latest";
const cursorSDK = await import(packageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoCursorSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoCursorSDKInstrumentation(cursorSDK));
