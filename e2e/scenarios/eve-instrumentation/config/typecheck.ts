import { braintrustEveInstrumentation } from "braintrust/instrumentation";
import { defineInstrumentation } from "eve/instrumentation";

defineInstrumentation(braintrustEveInstrumentation({}));
