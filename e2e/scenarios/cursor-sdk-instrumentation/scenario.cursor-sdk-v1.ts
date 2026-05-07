import * as cursorSDK from "cursor-sdk-v1";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedCursorSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedCursorSDKInstrumentation(cursorSDK));
