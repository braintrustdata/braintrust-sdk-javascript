import { readFile } from "node:fs/promises";
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

  const baseClient = new typesafe.TypeSafeClient({
    compression: false,
    ...(process.env.TYPESAFE_SUPPORTS_IMAGES === "1"
      ? { defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" } }
      : {}),
  });
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

      if (process.env.TYPESAFE_SUPPORTS_IMAGES !== "1") return;

      const bytes = await readFile(
        new URL("./test-image.png", import.meta.url),
      );
      await runOperation(
        "typesafe-image-operation",
        "image",
        async () => {
          await client.systemOne({
            model: "jev-preview",
            state: typesafe.image(bytes),
            questions: { ship: typesafe.noul("Is there a sailing ship?") },
          });
        },
        { autoCaptureAttachments: false },
      );

      await runOperation(
        "typesafe-template-operation",
        "template",
        async () => {
          const photo = typesafe.Image.fromBase64(bytes.toString("base64"));
          await client
            .systemOne({
              model: "jev-preview",
              state: {
                scene: typesafe.withAssets`Look at ${typesafe.withAssets.join([photo], ", ")}.`,
              },
              questions: {
                weather: typesafe.choice(
                  typesafe.withAssets`What weather is shown in ${photo}?`,
                  {
                    stormy: typesafe.withAssets`Stormy weather in ${photo}`,
                    clear: "Clear skies",
                  },
                ),
              },
            })
            .withResponse();
        },
        { autoCaptureAttachments: true },
      );

      await runOperation(
        "typesafe-box-operation",
        "box",
        async () => {
          const photo = typesafe.image(
            new Blob([bytes], { type: "image/png" }),
          );
          const response = await client
            .systemOne({
              model: "jev-preview",
              state: {
                "photos~/": ["<photo>"],
                description: "Locate the ship.",
              },
              assets: { "<photo>": photo },
              questions: {
                ship: typesafe.box("The sailing ship"),
                mast: typesafe.box("The tallest mast on the ship"),
                present: typesafe.noul("Is there a sailing ship?"),
                weather: typesafe.choice("What weather is shown?", {
                  stormy: null,
                  clear: null,
                }),
                waves: typesafe.score("How rough are the waves?", [
                  "calm",
                  "rough",
                ]),
              },
            })
            .asResponse();
          if (response.bodyUsed)
            throw new Error("Instrumentation consumed the image response");
          const result = await response.json();
          if (result.answers.ship.type !== "box")
            throw new Error("Expected a box answer");
        },
        { autoCaptureAttachments: true },
      );
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
