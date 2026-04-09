import * as adk from "@google/adk";
import { wrapGoogleADK } from "braintrust";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleADKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGoogleADKInstrumentation(wrapGoogleADK(adk)));
