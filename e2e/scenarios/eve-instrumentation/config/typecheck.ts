import { braintrustEveHook, braintrustEveInstrumentation } from "braintrust";
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";
import { defineInstrumentation } from "eve/instrumentation";

defineHook(braintrustEveHook({ defineState }));
defineInstrumentation(braintrustEveInstrumentation({ defineState }));
defineInstrumentation(braintrustEveInstrumentation({}));
