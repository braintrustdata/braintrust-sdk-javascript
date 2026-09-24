import type { WorkflowInfo, Sinks } from "@temporalio/workflow";
import type { InjectedSinks } from "@temporalio/worker";
import * as braintrust from "braintrust";

// Sink interface (used in workflow code via proxySinks)
// NOTE: WorkflowInfo is NOT included here - it's automatically injected by the runtime
export interface BraintrustSinks extends Sinks {
  braintrust: {
    workflowStarted(parentContext?: string, workflowSpanId?: string): void;
    workflowCompleted(error?: string): void;
  };
}

// Active workflow spans tracked by run ID
const workflowSpans = new Map<string, braintrust.Span>();
// Workflow span exports tracked by run ID (as promises for async export)
const workflowSpanExports = new Map<string, Promise<string>>();

/**
 * Get the exported span context for a workflow by run ID.
 * Activities on the same worker can use this to parent to the workflow span.
 */
export function getWorkflowSpanExport(
  runId: string,
): Promise<string> | undefined {
  return workflowSpanExports.get(runId);
}

/**
 * Create the Braintrust sinks for workflow span management.
 * These sinks are called from the workflow isolate via proxySinks.
 */
export function createBraintrustSinks(): InjectedSinks<BraintrustSinks> {
  return {
    braintrust: {
      workflowStarted: {
        fn: (
          info: WorkflowInfo,
          parentContext?: string,
          workflowSpanId?: string,
        ) => {
          const span = braintrust.startSpan({
            [Symbol.for("braintrust.spanInstrumentationName")]: "temporal",
            name: `temporal.workflow.${info.workflowType}`,
            spanAttributes: { type: "task" },
            parent: parentContext,
            spanId: workflowSpanId,
            event: {
              metadata: {
                "temporal.workflow_type": info.workflowType,
                "temporal.workflow_id": info.workflowId,
                "temporal.run_id": info.runId,
              },
            },
          });
          workflowSpans.set(info.runId, span);
          workflowSpanExports.set(info.runId, span.export());
        },
        callDuringReplay: false,
      },
      workflowCompleted: {
        fn: (info: WorkflowInfo, error?: string) => {
          const span = workflowSpans.get(info.runId);
          if (span) {
            if (error) {
              span.log({ error });
            }
            span.end();
            workflowSpans.delete(info.runId);
            workflowSpanExports.delete(info.runId);
          }
        },
        callDuringReplay: false,
      },
    },
  };
}
