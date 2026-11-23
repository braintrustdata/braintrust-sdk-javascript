import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { runMain } from "../../helpers/scenario-runtime";

runMain(async () => {
  const { Miniflare } = await import(process.env.MINIFLARE_PACKAGE_NAME!);
  const baseURL = process.env.CLOUDFLARE_BASE_URL;
  const bindingOnly = process.env.WORKERS_AI_BINDING_ONLY === "true";
  if (!baseURL && !bindingOnly)
    throw new Error("Workers AI e2e requires the cassette transport");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token =
    process.env.CLOUDFLARE_AI_API_KEY || process.env.CLOUDFLARE_API_TOKEN;
  if ((!account || !token) && !bindingOnly) {
    throw new Error(
      "Recording Workers AI requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_KEY (or CLOUDFLARE_API_TOKEN)",
    );
  }

  // Translate the native binding's private wire format to the public REST API.
  // The cassette server supplies real provider responses in both lanes.
  const transport = createServer(async (request, response) => {
    try {
      if (bindingOnly)
        throw new Error("Binding-only test must not call inference");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { inputs } = JSON.parse(Buffer.concat(chunks).toString());
      const model = request.headers["cf-consn-model-id"];
      if (
        typeof model !== "string" ||
        !/^@cf\/cloudflare\/(clef|clef-flash|clef-omni|clairic)$/.test(model)
      ) {
        throw new Error("Unexpected Workers AI model in recording transport");
      }
      const upstream = await fetch(
        `${baseURL}/client/v4/accounts/${encodeURIComponent(account!)}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(inputs),
        },
      );
      const body = await upstream.json();
      response.writeHead(upstream.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(upstream.ok ? body.result : body));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          errors: [
            {
              code: 502,
              message:
                error instanceof Error
                  ? error.message
                  : "Recording transport failed",
            },
          ],
        }),
      );
    }
  });
  transport.listen(0, "127.0.0.1");
  await once(transport, "listening");
  const address = transport.address();
  if (!address || typeof address === "string")
    throw new Error("Missing recording transport address");
  let mf;
  try {
    const built = await build({
      entryPoints: ["worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      external: ["node:*", "cloudflare:*"],
    });
    const names = [
      "BRAINTRUST_API_KEY",
      "BRAINTRUST_APP_URL",
      "BRAINTRUST_APP_PUBLIC_URL",
      "BRAINTRUST_API_URL",
      "BRAINTRUST_E2E_RUN_ID",
      "BRAINTRUST_E2E_PROJECT_NAME",
      "BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS",
      "WORKERS_AI_BINDING_ONLY",
    ];
    mf = new Miniflare({
      modules: true,
      script: built.outputFiles[0].text,
      compatibilityDate: "2026-07-20",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ...Object.fromEntries(
          names.map((key) => [key, process.env[key] ?? ""]),
        ),
        TEST_IMAGE: (await readFile("test-image.png")).toString("base64"),
      },
      unsafeBindings: [
        {
          name: "AI",
          type: "ai",
          plugin: {
            package: path.resolve("ai-binding-plugin.mjs"),
            name: "workersAIRecording",
          },
          options: { address: `127.0.0.1:${address.port}` },
        },
      ],
    });
    const response = await mf.dispatchFetch("http://localhost/run");
    if (!response.ok)
      throw new Error(
        `Worker failed (${response.status}): ${await response.text()}`,
      );
    const outcome = await response.json();
    if (outcome.ok !== true)
      throw new Error("Worker did not finish its assertions");
  } finally {
    await mf?.dispose();
    transport.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      transport.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
