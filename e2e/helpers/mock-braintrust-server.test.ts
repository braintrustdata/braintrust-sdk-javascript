import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { startMockBraintrustServer } from "./mock-braintrust-server";

describe("production forwarding", () => {
  it.each(["/logs3", "/otel/v1/traces"])(
    "preserves write order for %s even when the initial write is slow",
    async (path) => {
      let releaseInitial!: () => void;
      const initialGate = new Promise<void>((resolve) => {
        releaseInitial = resolve;
      });
      let initialReceived!: () => void;
      const initialStarted = new Promise<void>((resolve) => {
        initialReceived = resolve;
      });
      const applied: number[] = [];
      let stored: Record<string, unknown> = {};
      const upstream = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const {
          sequence,
          rows: [row],
        } = JSON.parse(body);
        if (sequence === 1) {
          initialReceived();
          await initialGate;
        }
        stored = row._is_merge ? { ...stored, ...row } : row;
        applied.push(sequence);
        res.end("{}");
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const server = await startMockBraintrustServer({
        prodForwarding: {
          apiKey: "test-only-key",
          apiUrl: url,
          appUrl: url,
          orgId: "org",
          orgName: "org",
          projectId: "project",
          projectName: "tmp-luca-forwarding-test",
        },
      });
      try {
        for (const [index, row] of [
          { id: "span", input: "hello", metrics: { start: 1 } },
          {
            id: "span",
            _is_merge: true,
            error: "expected failure",
            metrics: { start: 1, end: 2 },
          },
        ].entries()) {
          const response = await fetch(`${server.url}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_version: 2,
              sequence: index + 1,
              rows: [row],
            }),
          });
          expect(response.ok).toBe(true);
          await response.text();
          if (index === 0) await initialStarted;
        }
        // Give an incorrectly concurrent second request time to overtake the
        // gated initial upsert. The mock should still acknowledge both promptly.
        await setTimeout(50);
        releaseInitial();
        await server.close();
        expect(applied).toEqual([1, 2]);
        expect(stored).toMatchObject({
          input: "hello",
          error: "expected failure",
          metrics: { end: 2 },
        });
      } finally {
        releaseInitial();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    },
  );

  it("reports a failed write without preventing later queued writes", async () => {
    const received: number[] = [];
    const upstream = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { sequence } = JSON.parse(body);
      received.push(sequence);
      res.statusCode = sequence === 1 ? 500 : 200;
      res.end(sequence === 1 ? "initial write failed" : "{}");
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const server = await startMockBraintrustServer({
      prodForwarding: {
        apiKey: "test-only-key",
        apiUrl: url,
        appUrl: url,
        orgId: "org",
        orgName: "org",
        projectId: "project",
        projectName: "tmp-luca-forwarding-test",
      },
    });
    try {
      for (const sequence of [1, 2]) {
        const response = await fetch(`${server.url}/logs3`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sequence, api_version: 2, rows: [] }),
        });
        await response.text();
      }
      await expect(server.close()).rejects.toThrow("initial write failed");
      expect(received).toEqual([1, 2]);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
