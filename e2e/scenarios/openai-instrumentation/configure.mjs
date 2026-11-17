import { configureInstrumentation } from "braintrust/instrumentation";

// Register before automatic instrumentation; select the redaction case at export.
configureInstrumentation({
  spanCustomizers: [
    {
      onSpanExport(data) {
        if (
          process.env.BRAINTRUST_E2E_REDACT_DECISION_IMAGES === "true" &&
          data.span_attributes?.name === "openai.decisions.create" &&
          data.input?.state
        ) {
          const content = data.input.state[0].content;
          content[1].image_url = "[redacted]";
          content.splice(3, 1);
        }
        return data;
      },
    },
  ],
});
