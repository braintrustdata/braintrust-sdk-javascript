import { registerInstrumentationConsumers } from "./instrumentation/instrumentation-consumers";
import { wrapOpenAI } from "./wrappers/oai";

registerInstrumentationConsumers();
// Compatibility with OpenAI clients created by the remote function runtime.
globalThis.__inherited_braintrust_wrap_openai = wrapOpenAI;
