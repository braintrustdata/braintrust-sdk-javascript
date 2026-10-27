import {
  currentSpan,
  initLogger,
  traced,
  wrapWorkersAI,
} from "braintrust/workerd";

type Env = {
  BRAINTRUST_API_KEY: string;
  BRAINTRUST_APP_URL: string;
  BRAINTRUST_APP_PUBLIC_URL: string;
  BRAINTRUST_E2E_PROJECT_NAME: string;
  BRAINTRUST_E2E_RUN_ID: string;
  WORKERS_AI_BINDING_ONLY: string;
  TEST_IMAGE: string;
  AI: {
    run(
      model: string,
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<any>;
    getLogs(): string[];
  };
};

export default {
  async fetch(_request: Request, env: Env) {
    const logger = initLogger({
      apiKey: env.BRAINTRUST_API_KEY,
      appUrl: env.BRAINTRUST_APP_URL || env.BRAINTRUST_APP_PUBLIC_URL,
      projectName: env.BRAINTRUST_E2E_PROJECT_NAME || "tmp-luca",
    });
    const ai = wrapWorkersAI(env.AI);
    if (wrapWorkersAI(ai) !== ai || ai.run !== ai.run)
      throw new Error("Binding wrapper is not idempotent");
    ai.getLogs(); // Exercise an uninstrumented native method with its real receiver.
    const decision = {
      model: "clef-flash",
      state: "Checkout has failed for every customer for an hour.",
      questions: {
        urgent: { type: "noul", instructions: "Is this urgent?" },
        team: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { engineering: "Errors and outages", billing: "Invoices" },
        },
        impact: {
          type: "score",
          instructions: "How many customers are affected?",
          criteria: ["None", "Some", "All"],
        },
      },
    };
    await logger.traced(
      async () => {
        if (env.WORKERS_AI_BINDING_ONLY === "true") {
          // Exercise the real native binding's serialization failure, without
          // fabricating a provider response or needing inference credentials.
          const invalid = { ...decision, unserializable: 1n };
          let originalError: unknown;
          try {
            await env.AI.run("@cf/cloudflare/clef-flash", invalid);
          } catch (error) {
            originalError = error;
          }
          if (!(originalError instanceof TypeError))
            throw new Error("Expected a native serialization TypeError");
          await Promise.all(
            ["binding-a", "binding-b"].map((name) =>
              traced(
                async () => {
                  const parent = currentSpan().id;
                  await Promise.resolve();
                  let rejected = false;
                  try {
                    await ai.run("@cf/cloudflare/clef-flash", invalid);
                  } catch (error) {
                    rejected =
                      error instanceof TypeError &&
                      error.message === originalError.message;
                  }
                  if (!rejected || currentSpan().id !== parent)
                    throw new Error("Native error or parent context changed");
                },
                { name },
              ),
            ),
          );
          return;
        }
        await Promise.all(
          ["decision-a", "decision-b"].map((name) =>
            traced(
              async () => {
                const value = await ai.run(
                  "@cf/cloudflare/clef-flash",
                  decision,
                );
                if (!value.answers?.team || !value.usage)
                  throw new Error("Missing Clef result");
              },
              { name },
            ),
          ),
        );
        await traced(
          async () => {
            const value = await ai.run("@cf/cloudflare/clairic", {
              model: "clairic",
              state:
                "Invoice INV-42. Two chairs at $15 each, shipping $5. Contact: Ada. Due 2026-11-01 at 09:30. Delivery takes 2 days. Daily sales were 2, 3, 4 units.",
              reference_date: "2026-10-23",
              options: { include_quantiles: true, return_state_text: true },
              fields: {
                invoice: { type: "text", instructions: "Invoice number" },
                total: {
                  type: "number",
                  decimals: 2,
                  instructions: "Total including shipping",
                },
                missing: {
                  type: "text",
                  instructions: "Purchase order number",
                },
                contacts: {
                  type: "list",
                  items: "text",
                  instructions: "Contact names",
                },
                due: { type: "date", instructions: "Due date" },
                time: { type: "time", instructions: "Due time" },
                delivery: {
                  type: "duration",
                  unit: "days",
                  instructions: "Delivery duration",
                },
                estimate: {
                  type: "estimate",
                  min: 0,
                  max: 10,
                  step: 1,
                  instructions: "Estimate tomorrow's unit sales",
                },
                forecast: {
                  type: "forecast",
                  min: 0,
                  max: 10,
                  step: 1,
                  horizon: 2,
                  interval: "day",
                  instructions: "Predict unit sales for the next two days",
                },
              },
            });
            if (!value.answers?.invoice || !value.usage)
              throw new Error("Missing Clairic result");
          },
          { name: "extraction" },
        );
        await traced(
          async () => {
            await ai.run("@cf/cloudflare/clairic", {
              model: "clairic",
              images: [{ content_type: "image/png", base64: env.TEST_IMAGE }],
              fields: {
                color: { type: "text", instructions: "The main visible color" },
              },
            });
          },
          { name: "image-extraction" },
        );
        await traced(
          async () => {
            const value = await ai.run("@cf/cloudflare/clef-flash", {
              model: "clef-flash",
              state: "Inspect the attached image.",
              images: [{ content_type: "image/png", base64: env.TEST_IMAGE }],
              questions: {
                visible: {
                  type: "noul",
                  instructions: "Is there visible content in this image?",
                },
              },
            });
            if (!value.answers?.visible)
              throw new Error("Missing image decision");
          },
          { name: "image-decision" },
        );
        await traced(
          async () => {
            let rejected = false;
            try {
              await ai.run("@cf/cloudflare/clef-flash", {
                model: "clef-flash",
                state: "invalid request",
                questions: {},
              });
            } catch {
              rejected = true;
            }
            if (!rejected)
              throw new Error(
                "Expected the provider to reject empty questions",
              );
          },
          { name: "provider-error" },
        );
        await traced(
          async () => {
            let rejected = false;
            try {
              await ai.run("@cf/cloudflare/clairic", {
                model: "clairic",
                state: "invalid request",
                fields: {},
              });
            } catch {
              rejected = true;
            }
            if (!rejected)
              throw new Error("Expected the provider to reject empty fields");
          },
          { name: "extraction-error" },
        );
        await traced(
          async () => {
            const response = await ai.run(
              "@cf/cloudflare/clef-flash",
              decision,
              { returnRawResponse: true },
            );
            if (!(response instanceof Response) || !response.ok)
              throw new Error("Raw response was not preserved");
            if (!(await response.json()).answers)
              throw new Error("Raw response body was consumed");
          },
          { name: "raw-response" },
        );
      },
      {
        name: "workers-ai-root",
        event: {
          metadata: {
            scenario: "workers-ai-instrumentation",
            testRunId: env.BRAINTRUST_E2E_RUN_ID,
          },
        },
      },
    );
    await logger.flush();
    return Response.json({ ok: true });
  },
};
