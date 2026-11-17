export type ApplicationLogOptions = {
  metadata?: Record<string, unknown>;
};

const LOG_TEMPLATE: unique symbol = Symbol.for("braintrust.logTemplate");

export type ApplicationLogTemplate = {
  readonly [LOG_TEMPLATE]: true;
  readonly body: string;
  readonly metadata: Record<string, unknown>;
};

/** Use JavaScript's native interpolation on the cooked template segments. */
export function formatLogTemplate(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): ApplicationLogTemplate {
  const placeholders = values.map((_, index) => `\${${index}}`);
  return {
    [LOG_TEMPLATE]: true,
    body: String.raw({ raw: strings }, ...values),
    metadata: {
      "braintrust.template": String.raw({ raw: strings }, ...placeholders),
      ...Object.fromEntries(
        values.map((value, index) => [
          `braintrust.template.parameter.${index}`,
          // Retain primitives that JSON cannot represent using their native text.
          value === undefined || typeof value === "bigint"
            ? String(value)
            : value,
        ]),
      ),
    },
  };
}

function isLogTemplate(body: unknown): body is ApplicationLogTemplate {
  return (
    typeof body === "object" &&
    body !== null &&
    Object.getOwnPropertyDescriptor(body, LOG_TEMPLATE)?.value === true
  );
}

export function renderLogBody(
  body: unknown,
  options?: ApplicationLogOptions,
): { body: unknown; metadata?: Record<string, unknown> } {
  if (!isLogTemplate(body)) return { body, metadata: options?.metadata };
  return {
    body: body.body,
    metadata: { ...options?.metadata, ...body.metadata },
  };
}

export type ApplicationLogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";
