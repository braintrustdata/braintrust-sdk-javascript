import { createHash } from "node:crypto";
import { expect, test } from "vite-plus/test";
import { redact } from "./cassette-filter.mjs";

test("redacts Mapbox credentials from binary Statsig configuration", () => {
  const config = {
    dynamic_configs: {
      example: {
        value: {
          mapbox_access_token: "test-mapbox-credential",
          enabled: true,
        },
      },
    },
    feature_gates: {},
    user: { appVersion: "1.2.0" },
  };
  const bytes = Buffer.from(JSON.stringify({ config: JSON.stringify(config) }));
  const redactor = redact.find(
    (rule): rule is Exclude<typeof rule, string> => typeof rule !== "string",
  );
  const response = redactor!.redactResponse({
    status: 200,
    headers: {},
    body: {
      kind: "binary-draft",
      bytes,
      contentType: "application/json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  const body = Buffer.from(response.body.bytes).toString("utf8");
  expect(body).not.toContain("test-mapbox-credential");
  expect(JSON.parse(JSON.parse(body).config).dynamic_configs).toEqual({
    example: {
      value: { mapbox_access_token: "[REDACTED]", enabled: true },
    },
  });
  expect(response.body.sha256).toBe(
    createHash("sha256").update(response.body.bytes).digest("hex"),
  );
});
