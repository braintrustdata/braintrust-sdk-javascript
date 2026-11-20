import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { wrapGroq } from "braintrust";
import { runTracedScenario } from "../../helpers/provider-runtime.mjs";

const { default: Groq } = await import(process.env.GROQ_PACKAGE_NAME);
const params = {
  input_file_id: "file-input",
  endpoint: "/v1/chat/completions",
  completion_window: "24h",
};
const batch = { ...params, object: "batch", created_at: 1, id: "batch-test" };
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.headers["x-test-request"] !== "batch") {
    res.writeHead(400).end();
  } else if (req.method === "POST" && req.url === "/openai/v1/batches") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.input_file_id !== params.input_file_id) res.writeHead(400).end();
    else res.end(JSON.stringify({ ...batch, status: "validating" }));
  } else if (
    req.method === "GET" &&
    req.url === "/openai/v1/batches/batch-test"
  ) {
    res.end(
      JSON.stringify({
        ...batch,
        status: "completed",
        request_counts: { total: 1, completed: 1, failed: 0 },
      }),
    );
  } else {
    res
      .writeHead(404)
      .end(JSON.stringify({ error: { message: "unknown batch" } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const groq = new Groq({
    apiKey: "fixture",
    baseURL: `http://127.0.0.1:${server.address().port}`,
    maxRetries: 0,
  });
  const client = process.env.GROQ_WRAP === "true" ? wrapGroq(groq) : groq;
  const options = { headers: { "x-test-request": "batch" } };
  await runTracedScenario({
    rootName: "batch operations",
    projectNameBase: "groq-batch",
    callback: async () => {
      const { data, response } = await client.batches
        .create(params, options)
        .withResponse();
      assert.equal(response.status, 200);
      assert.equal(data.id, batch.id);
      const result = await client.batches.retrieve(data.id, options);
      assert.equal(result.status, "completed");
      await assert.rejects(
        client.batches.retrieve("missing", options),
        (err) =>
          err instanceof Groq.NotFoundError &&
          err.status === 404 &&
          err.message.includes("unknown batch"),
      );
    },
  });
} finally {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}
