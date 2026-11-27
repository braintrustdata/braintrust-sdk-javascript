// A response header whose presence indicates that an object insert operation

import { SpanObjectTypeV3 } from "./span_identifier_v3";
import { SpanComponentsV4 } from "./span_identifier_v4";

// (POST or PUT) encountered an existing version of the object.
export const BT_FOUND_EXISTING_HEADER = "x-bt-found-existing";

// The pagination cursor header.
export const BT_CURSOR_HEADER = "x-bt-cursor";

// User impersonation header.
export const BT_IMPERSONATE_USER = "x-bt-impersonate-user";

// Parent header for OTEL exporters.
export const BT_PARENT = "x-bt-parent";

const EXPERIMENT_ID_PREFIX = "experiment_id:";
const PROJECT_ID_PREFIX = "project_id:";
const PROJECT_NAME_PREFIX = "project_name:";
const PLAYGROUND_ID_PREFIX = "playground_id:";

export function resolveParentHeader(header: string): SpanComponentsV4 {
  if (header.startsWith(EXPERIMENT_ID_PREFIX)) {
    return new SpanComponentsV4({
      object_type: SpanObjectTypeV3.EXPERIMENT,
      object_id: header.substring(EXPERIMENT_ID_PREFIX.length),
    });
  } else if (header.startsWith(PROJECT_ID_PREFIX)) {
    return new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: header.substring(PROJECT_ID_PREFIX.length),
    });
  } else if (header.startsWith(PLAYGROUND_ID_PREFIX)) {
    return new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PLAYGROUND_LOGS,
      object_id: header.substring(PLAYGROUND_ID_PREFIX.length),
    });
  } else if (header.startsWith(PROJECT_NAME_PREFIX)) {
    const projectName = header.substring(PROJECT_NAME_PREFIX.length);
    return new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      compute_object_metadata_args: {
        project_name: projectName,
      },
    });
  }

  return SpanComponentsV4.fromStr(header);
}
