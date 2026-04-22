import iso, { CallerLocation } from "./isomorph";

export interface StackTraceEntry {
  functionName: string;
  fileName: string;
  lineNo: number;
}

function getStackTrace(): StackTraceEntry[] {
  const trace = new Error().stack;
  if (typeof trace !== "string") {
    return [];
  }
  const traceLines = trace.split("\n");
  const out: StackTraceEntry[] = [];
  const stackFrameRegex = /^\s*at\s+(?:(.+?)\s+\()?(.*):(\d+):(\d+)\)?\s*$/;
  for (const traceLine of traceLines.slice(1)) {
    const matches = traceLine.match(stackFrameRegex);
    if (matches === null || matches.length !== 5) {
      continue;
    }
    const entry: StackTraceEntry = {
      functionName: matches[1]?.trim() ?? "",
      fileName: matches[2],
      lineNo: parseInt(matches[3], 10),
    };
    if (!isNaN(entry.lineNo)) {
      out.push(entry);
    }
  }
  return out;
}

// Fetches the first StackTraceEntry not contained inside the same directory as
// this file and converts it into a CallerLocation.
export function getCallerLocation(): CallerLocation | undefined {
  let thisDir: string | undefined = undefined;
  const entries = getStackTrace();
  for (const frame of entries) {
    if (thisDir === undefined) {
      thisDir = iso.pathDirname?.(frame.fileName);
    }
    if (iso.pathDirname?.(frame.fileName) !== thisDir) {
      return {
        caller_functionname: frame.functionName,
        caller_filename: frame.fileName,
        caller_lineno: frame.lineNo,
      };
    }
  }
  return undefined;
}
