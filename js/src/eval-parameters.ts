import { z } from "zod/v3";
import Ajv from "ajv";
import { Prompt, RemoteEvalParameters } from "./logger";
import {
  promptDefinitionWithToolsSchema,
  promptDefinitionToPromptData,
} from "./prompt-schemas";
import { PromptData as promptDataSchema } from "./generated_types";

// Schema for evaluation parameters
export const evalParametersSchema = z.record(
  z.string(),
  z.union([
    z.object({
      type: z.literal("prompt"),
      default: promptDefinitionWithToolsSchema.optional(),
      description: z.string().optional(),
    }),
    z.object({
      type: z.literal("model"),
      default: z.string().optional(),
      description: z.string().optional(),
    }),
    z.instanceof(z.ZodType), // For Zod schemas
  ]),
);

export type EvalParameters = z.infer<typeof evalParametersSchema>;

// Type helper to infer the type of a parameter value
type InferParameterValue<T> = T extends { type: "prompt" }
  ? Prompt
  : T extends { type: "model" }
    ? string
    : T extends z.ZodType
      ? z.infer<T>
      : never;

// Type helper to infer the full parameters type
export type InferParameters<T extends EvalParameters> = {
  [K in keyof T]: InferParameterValue<T[K]>;
};

export async function validateParameters<
  Parameters extends EvalParameters = EvalParameters,
  T extends Record<string, unknown> = InferParameters<Parameters>,
>(
  parameters: Record<string, unknown>,
  parameterSchema: Parameters | Promise<unknown> | unknown,
): Promise<T> {
  let resolvedSchema = parameterSchema;
  if (resolvedSchema instanceof Promise) {
    resolvedSchema = await resolvedSchema;
  }

  // If no schema is provided, return parameters as-is
  if (resolvedSchema === undefined || resolvedSchema === null) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return parameters as T;
  }

  if (RemoteEvalParameters.isParameters(resolvedSchema)) {
    const mergedParameters =
      parameters && Object.keys(parameters).length > 0
        ? {
            ...resolvedSchema.data,
            ...parameters,
          }
        : resolvedSchema.data;

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return validateParametersWithJsonSchema(
      mergedParameters,
      resolvedSchema.schema,
    ) as T;
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return validateParametersWithZod(
    parameters,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    resolvedSchema as Parameters,
  ) as T;
}

function validateParametersWithZod<
  Parameters extends EvalParameters = EvalParameters,
>(
  parameters: Record<string, unknown>,
  parameterSchema: Parameters,
): InferParameters<Parameters> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return Object.fromEntries(
    Object.entries(parameterSchema).map(([name, schema]) => {
      const value = parameters[name];
      try {
        if ("type" in schema && schema.type === "prompt") {
          const promptData = value
            ? promptDataSchema.parse(value)
            : schema.default
              ? promptDefinitionToPromptData(
                  schema.default,
                  schema.default.tools,
                )
              : undefined;
          if (!promptData) {
            throw new Error(`Parameter '${name}' is required`);
          }
          return [name, Prompt.fromPromptData(name, promptData)];
        } else if ("type" in schema && schema.type === "model") {
          const model = value ?? schema.default;
          if (model === undefined) {
            throw new Error(`Parameter '${name}' is required`);
          }
          if (typeof model !== "string") {
            throw new Error(
              `Parameter '${name}' must be a string model identifier`,
            );
          }
          return [name, model];
        } else {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          const schemaCasted = schema as z.ZodSchema<unknown>;
          return [name, schemaCasted.parse(value)];
        }
      } catch (e) {
        console.error("Error validating parameter", name, e);
        throw Error(
          `Invalid parameter '${name}': ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),
  ) as InferParameters<Parameters>;
}

function validateParametersWithJsonSchema<T extends Record<string, unknown>>(
  parameters: Record<string, unknown>,
  schema: Record<string, unknown>,
): T {
  const ajv = new Ajv({ coerceTypes: true, useDefaults: true, strict: false });
  const validate = ajv.compile(schema);

  if (!validate(parameters)) {
    const errorMessages = validate.errors
      ?.map((err) => {
        const path = err.instancePath || "root";
        return `${path}: ${err.message}`;
      })
      .join(", ");
    throw Error(`Invalid parameters: ${errorMessages}`);
  }

  return rehydrateRemoteParameters(parameters, schema) as T;
}

function rehydrateRemoteParameters(
  parameters: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const schemaProperties = schema.properties;
  if (typeof schemaProperties !== "object" || schemaProperties === null) {
    return parameters;
  }

  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => {
      const propertySchema = Reflect.get(schemaProperties, name);
      if (typeof propertySchema !== "object" || propertySchema === null) {
        return [name, value];
      }

      if (Reflect.get(propertySchema, "x-bt-type") === "prompt") {
        return [
          name,
          Prompt.fromPromptData(name, promptDataSchema.parse(value)),
        ];
      }

      return [name, value];
    }),
  );
}
