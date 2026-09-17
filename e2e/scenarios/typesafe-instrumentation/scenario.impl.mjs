import { wrapTypeSafe } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "typesafe-instrumentation-root";
export const SCENARIO_NAME = "typesafe-instrumentation";

export async function runTypeSafeInstrumentationScenario(
  typesafe,
  { decorateClient } = {},
) {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error("Expected TYPESAFE_API_KEY to be set for e2e");
  }

  const baseClient = new typesafe.TypeSafeClient();
  const client = decorateClient ? decorateClient(baseClient) : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("typesafe-mixed-operation", "mixed", async () => {
        const promise = client.systemOne({
          state: {
            message:
              "I was charged twice. Please refund the duplicate charge today.",
          },
          questions: {
            category: typesafe.choice("Which team should handle this?", {
              billing: null,
              technical: null,
              other: null,
            }),
            urgency: typesafe.score("How urgent is this request?", [
              "routine",
              "soon",
              "urgent",
            ]),
            duplicate_charge: typesafe.noul({
              question: "Does the customer report a duplicate charge?",
            }),
          },
        });
        const mapped = promise.map((result) => result.answers.category.choice);
        const [{ data, requestId }, category] = await Promise.all([
          promise.withResponse(),
          mapped,
        ]);
        if (!requestId || category !== data.answers.category.choice) {
          throw new Error("TypeSafe APIPromise helpers were not preserved");
        }
      });

      await runOperation("typesafe-raw-operation", "raw", async () => {
        const response = await client
          .systemOne({
            model: "jev-1.13.0",
            state: "The package arrived intact and on time.",
            questions: {
              positive: typesafe.noul("Is this feedback positive?"),
            },
          })
          .asResponse();
        if (response.bodyUsed) {
          throw new Error(
            "Instrumentation consumed the caller's response body",
          );
        }
        const data = await response.json();
        if (data.answers?.positive?.type !== "noul") {
          throw new Error("Unexpected TypeSafe raw response");
        }
      });
    },
    metadata: { scenario: SCENARIO_NAME },
    projectNameBase: "tmp-luca-e2e-typesafe-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedTypeSafeInstrumentation(typesafe) {
  await runTypeSafeInstrumentationScenario(typesafe, {
    decorateClient: wrapTypeSafe,
  });
}

export async function runAutoTypeSafeInstrumentation(typesafe) {
  await runTypeSafeInstrumentationScenario(typesafe);
}
