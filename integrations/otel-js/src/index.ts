import { OtelContextManager } from "./context";
import { configureContextManager } from "braintrust";

export {
  contextFromSpan,
  addSpanParentToBaggage,
  addParentToBaggage,
  parentFromHeaders,
  isRootSpan,
} from "./otel";

export { BraintrustSpanProcessor, BraintrustExporter } from "./otel";

export const setupOtelCompat = () => {
  configureContextManager(OtelContextManager);
};

export const resetOtelCompat = () => {
  configureContextManager(undefined);
};
