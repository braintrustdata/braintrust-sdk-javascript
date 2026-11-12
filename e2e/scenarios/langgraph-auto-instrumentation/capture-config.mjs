import { configureInstrumentation } from "braintrust/instrumentation";

export const captureOptions = {
  captureChainInputs: false,
  captureChainOutputs: false,
  captureModelInputs: false,
  captureModelOutputs: false,
  captureModelTokenUsage: false,
};
configureInstrumentation({ langchain: captureOptions });
