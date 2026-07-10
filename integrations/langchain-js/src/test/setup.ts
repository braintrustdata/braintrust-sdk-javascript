import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export const server = setupServer(
  http.post(/.+\/api\/apikey\/login/, () => {
    return HttpResponse.json({
      org_info: [
        {
          id: "abb9f3e4-7fdd-4ccc-af40-f7e894fd4125",
          name: "braintrustdata.com",
          api_url: "http://0.0.0.0:8000",
          git_metadata: null,
          is_universal_api: null,
          proxy_url: "http://0.0.0.0:8000",
          realtime_url: "ws://0.0.0.0:8788",
        },
      ],
    });
  }),

  http.post(/.+\/api\/project\/register/, () => {
    return HttpResponse.json({
      project: {
        id: "209220fc-d3bd-4fab-b1a4-af5827d69200",
        org_id: "abb9f3e4-7fdd-4ccc-af40-f7e894fd4125",
        name: "Global",
        created: "2024-12-04T16:14:11.122Z",
        deleted_at: null,
        user_id: "fac36c53-c882-458b-bf80-60d06c3e8a0d",
        settings: null,
      },
    });
  }),
);

beforeAll(() => {
  process.env.BRAINTRUST_API_KEY = "braintrust-api-key";
  process.env.BRAINTRUST_APP_URL = "http://braintrust.local";
  process.env.BRAINTRUST_ORG_NAME = "braintrustdata.com";
  process.env.OPENAI_API_KEY = "openai-api-key";

  server.listen({
    onUnhandledRequest: (req) => {
      throw new Error(`Unhandled request ${req.method}, ${req.url}`);
    },
  });
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());
