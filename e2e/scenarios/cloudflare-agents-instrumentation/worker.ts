import { Agent, getAgentByName } from "agents";
import { initLogger, wrapCloudflareAgent } from "braintrust/workerd";

declare const __CLOUDFLARE_AGENTS_INSTRUMENTATION_MODE__: string;

type ToolInput = {
  case: "success" | "error" | "concurrent-a" | "concurrent-b" | "detached";
  delayMs: number;
  value: string;
};

type StoredRun = {
  completed_at: number | null;
  error_message: string | null;
  output_json: string | null;
  run_id: string;
  started_at: number;
  status: "aborted" | "completed" | "error";
};

const BaseParentAgent =
  __CLOUDFLARE_AGENTS_INSTRUMENTATION_MODE__ === "wrapped"
    ? wrapCloudflareAgent(Agent)
    : Agent;

export class DeterministicToolAgent extends Agent {
  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS deterministic_tool_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        output_json TEXT,
        error_message TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `;
  }

  async startAgentToolRun(input: ToolInput, options: { runId: string }) {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    const completedAt = Date.now();
    const isError = input.case === "error";
    const output = isError
      ? undefined
      : { case: input.case, echoed: input.value };
    const error = isError ? "deterministic child failure" : undefined;

    this.sql`
      INSERT OR REPLACE INTO deterministic_tool_runs (
        run_id, status, output_json, error_message, started_at, completed_at
      ) VALUES (
        ${options.runId}, ${isError ? "error" : "completed"},
        ${output === undefined ? null : JSON.stringify(output)},
        ${error ?? null}, ${startedAt}, ${completedAt}
      )
    `;

    return {
      runId: options.runId,
      status: isError ? ("error" as const) : ("completed" as const),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      startedAt,
      completedAt,
    };
  }

  async cancelAgentToolRun(runId: string, reason?: unknown) {
    const error =
      reason instanceof Error ? reason.message : String(reason ?? "cancelled");
    this.sql`
      UPDATE deterministic_tool_runs
      SET status = 'aborted', error_message = ${error}, completed_at = ${Date.now()}
      WHERE run_id = ${runId}
    `;
  }

  async inspectAgentToolRun(runId: string) {
    const row = this.sql<StoredRun>`
      SELECT run_id, status, output_json, error_message, started_at, completed_at
      FROM deterministic_tool_runs
      WHERE run_id = ${runId}
    `[0];
    if (!row) {
      return null;
    }

    return {
      runId: row.run_id,
      status: row.status,
      ...(row.output_json === null
        ? {}
        : { output: JSON.parse(row.output_json) as unknown }),
      ...(row.error_message === null ? {} : { error: row.error_message }),
      startedAt: row.started_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
  }

  async getAgentToolChunks(
    _runId: string,
    _options?: { afterSequence?: number },
  ) {
    return [];
  }

  async tailAgentToolRun(runId: string, options?: { afterSequence?: number }) {
    const chunks = await this.getAgentToolChunks(runId, options);
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      },
    });
  }
}

export class ParentAgent extends BaseParentAgent {
  async runInstrumentationScenario(testRunId: string, projectName: string) {
    const logger = initLogger({ projectName });
    const result = await logger.traced(
      async () => {
        const success = await this.runAgentTool(DeterministicToolAgent, {
          input: { case: "success", delayMs: 10, value: "allowed-success" },
          runId: "forbidden-run-id-marker",
          parentToolCallId: "forbidden-parent-tool-call-marker",
          displayOrder: 91,
          inputPreview: "forbidden-input-preview-marker",
          display: { name: "forbidden-display-marker" },
        });
        const failure = await this.runAgentTool(DeterministicToolAgent, {
          input: { case: "error", delayMs: 10, value: "allowed-error" },
          runId: "returned-error-run",
        });
        const concurrent = await Promise.all([
          this.runAgentTool(DeterministicToolAgent, {
            input: {
              case: "concurrent-a",
              delayMs: 75,
              value: "allowed-a",
            },
            runId: "concurrent-a-run",
          }),
          this.runAgentTool(DeterministicToolAgent, {
            input: {
              case: "concurrent-b",
              delayMs: 75,
              value: "allowed-b",
            },
            runId: "concurrent-b-run",
          }),
        ]);
        const detached = await this.runAgentTool(DeterministicToolAgent, {
          input: { case: "detached", delayMs: 5, value: "allowed-detached" },
          runId: "detached-run",
          detached: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        return { concurrent, detached, failure, success };
      },
      {
        name: "cloudflare-agents-e2e-root",
        event: {
          metadata: {
            instrumentationMode: __CLOUDFLARE_AGENTS_INSTRUMENTATION_MODE__,
            scenario: "cloudflare-agents-instrumentation",
            testRunId,
          },
        },
      },
    );
    await logger.flush();
    return result;
  }
}

type WorkerEnv = {
  PARENT_AGENT: DurableObjectNamespace<ParentAgent>;
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = (await request.json()) as {
      projectName: string;
      testRunId: string;
    };
    const parent = await getAgentByName(env.PARENT_AGENT, body.testRunId);
    const result = await parent.runInstrumentationScenario(
      body.testRunId,
      body.projectName,
    );
    return Response.json(result);
  },
};
