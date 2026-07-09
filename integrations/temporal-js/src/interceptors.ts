import type { Context } from "@temporalio/activity";
import type {
  ActivityInboundCallsInterceptor,
  ActivityExecuteInput,
  Next,
  ActivityInterceptors,
} from "@temporalio/worker";
import type { WorkflowClientInterceptor } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import * as braintrust from "braintrust";
import { SpanComponentsV4 } from "braintrust/util";
import { getWorkflowSpanExport } from "./sinks";
import {
  BRAINTRUST_SPAN_HEADER,
  BRAINTRUST_WORKFLOW_SPAN_ID_HEADER,
  deserializeHeaderValue,
} from "./utils";

/**
 * Create a client interceptor that propagates Braintrust span context to workflows.
 * Use this when creating a Temporal Client to enable trace context propagation.
 */
export function createBraintrustClientInterceptor(): WorkflowClientInterceptor {
  return {
    async start(input, next) {
      const span = braintrust.currentSpan();
      if (span) {
        const exported = await span.export();
        if (exported) {
          const payload = defaultPayloadConverter.toPayload(exported);
          if (payload) {
            return next({
              ...input,
              headers: {
                ...input.headers,
                [BRAINTRUST_SPAN_HEADER]: payload,
              },
            });
          }
        }
      }
      return next(input);
    },
    async signal(input, next) {
      return next(input);
    },
    async signalWithStart(input, next) {
      const span = braintrust.currentSpan();
      if (span) {
        const exported = await span.export();
        if (exported) {
          const payload = defaultPayloadConverter.toPayload(exported);
          if (payload) {
            return next({
              ...input,
              headers: {
                ...input.headers,
                [BRAINTRUST_SPAN_HEADER]: payload,
              },
            });
          }
        }
      }
      return next(input);
    },
  };
}

/**
 * Activity interceptor that creates Braintrust spans for activity executions.
 */
class BraintrustActivityInterceptor implements ActivityInboundCallsInterceptor {
  constructor(private ctx: Context) {}

  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, "execute">,
  ): Promise<unknown> {
    const info = this.ctx.info;
    const runId = info.workflowExecution.runId;

    // Try to get workflow span export - first check local Map, then headers
    let parent: string | undefined;

    // Check if we have the workflow span export locally (same worker as workflow)
    const spanExportPromise = getWorkflowSpanExport(runId);
    if (spanExportPromise) {
      try {
        parent = await spanExportPromise;
      } catch {
        // Ignore errors, fall through to header check
      }
    }

    // For cross-worker activities: construct parent from workflow span ID + client context
    if (!parent && input.headers) {
      const workflowSpanId = deserializeHeaderValue(
        input.headers[BRAINTRUST_WORKFLOW_SPAN_ID_HEADER],
      );
      const clientContext = deserializeHeaderValue(
        input.headers[BRAINTRUST_SPAN_HEADER],
      );

      if (workflowSpanId && clientContext) {
        try {
          const clientComponents = SpanComponentsV4.fromStr(clientContext);
          const clientData = clientComponents.data;

          // We can only construct a workflow parent if we have:
          // 1. Tracing context (root_span_id)
          // 2. Object metadata (object_id or compute_object_metadata_args)
          const hasTracingContext = !!clientData.root_span_id;
          const hasObjectMetadata =
            !!clientData.object_id || !!clientData.compute_object_metadata_args;

          if (hasTracingContext && hasObjectMetadata) {
            // Construct workflow parent with the workflow's span ID
            // IMPORTANT: row_id must match span_id for the parent span
            // Must provide EITHER object_id OR compute_object_metadata_args, not both
            const workflowParentBase = {
              object_type: clientData.object_type,
              propagated_event: clientData.propagated_event,
              row_id: workflowSpanId, // Use workflow's row_id, not client's
              span_id: workflowSpanId, // Use workflow's span_id, not client's
              root_span_id: clientData.root_span_id, // Keep same trace
            };
            const workflowComponents = clientData.object_id
              ? new SpanComponentsV4({
                  ...workflowParentBase,
                  object_id: clientData.object_id,
                })
              : new SpanComponentsV4({
                  ...workflowParentBase,
                  compute_object_metadata_args:
                    clientData.compute_object_metadata_args!,
                });

            parent = workflowComponents.toStr();
          } else {
            // Client context doesn't have root_span_id, use it directly
            parent = clientContext;
          }
        } catch {
          // Fall back to client context if parsing fails
          parent = clientContext;
        }
      } else if (clientContext) {
        // No workflow span ID, use client context directly
        parent = clientContext;
      }
    }

    const span = braintrust.startSpan({
      name: `temporal.activity.${info.activityType}`,
      spanAttributes: { type: "task" },
      parent,
      event: {
        metadata: {
          "temporal.activity_type": info.activityType,
          "temporal.activity_id": info.activityId,
          "temporal.workflow_id": info.workflowExecution.workflowId,
          "temporal.workflow_run_id": runId,
        },
      },
    });

    try {
      const result = await braintrust.withCurrent(span, () => next(input));
      span.log({ output: result });
      span.end();
      return result;
    } catch (e) {
      span.log({ error: String(e) });
      span.end();
      throw e;
    }
  }
}

/**
 * Create an activity interceptor factory for use with Worker.create().
 * This factory creates BraintrustActivityInterceptor instances for each activity.
 */
export function createBraintrustActivityInterceptor(
  ctx: Context,
): ActivityInterceptors {
  return {
    inbound: new BraintrustActivityInterceptor(ctx),
  };
}
