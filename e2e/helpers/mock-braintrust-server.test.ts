import { afterEach, expect, it, vi } from "vitest";
import { startMockBraintrustServer } from "./mock-braintrust-server";

afterEach(() => vi.restoreAllMocks());

it.each([
  { path: "/logs3", statuses: [502, 503, 504, 200], succeeds: true },
  { path: "/logs3", statuses: [502, 502, 502, 502], succeeds: false },
  { path: "/logs3", statuses: [400], succeeds: false },
  { path: "/api/project/register", statuses: [502], succeeds: false },
])(
  "forwards $path with responses $statuses",
  async ({ path, statuses, succeeds }) => {
    const realFetch = globalThis.fetch;
    const forward = vi.spyOn(globalThis, "fetch");
    for (const status of statuses) {
      forward.mockResolvedValueOnce(new Response("{}", { status }));
    }
    const server = await startMockBraintrustServer({
      prodForwarding: {
        apiKey: "test-forwarding-key",
        apiUrl: "https://forwarding.invalid",
        appUrl: "https://forwarding.invalid",
        orgId: "test-org",
        orgName: "test-org",
        projectId: "test-project",
        projectName: "tmp-luca-forwarding-test",
      },
    });
    const body = JSON.stringify({
      api_version: 2,
      rows: [{ id: "test-row", project_id: "test-project" }],
    });
    try {
      const response = await realFetch(`${server.url}${path}`, {
        method: "POST",
        body,
      });
      await response.text();
    } finally {
      if (succeeds) {
        await server.close();
      } else {
        await expect(server.close()).rejects.toThrow(
          `prodForwarding failed for POST ${path}: ${statuses.at(-1)}`,
        );
      }
    }

    expect(forward).toHaveBeenCalledTimes(statuses.length);
    for (const [url, init] of forward.mock.calls) {
      expect(String(url)).toBe(`https://forwarding.invalid${path}`);
      expect(init?.body).toBe(body);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-forwarding-key",
      );
    }
    expect(server.requests).toHaveLength(1);
    expect(server.payloads).toHaveLength(path === "/logs3" ? 1 : 0);
  },
);
