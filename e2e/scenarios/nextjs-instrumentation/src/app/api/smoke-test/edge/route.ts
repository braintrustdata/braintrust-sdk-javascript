import { NextResponse } from "next/server";
import {
  formatRouteError,
  runRuntimeCheck,
} from "../../../../lib/runtime-check";

export const runtime = "edge";

export async function GET() {
  try {
    return NextResponse.json(await runRuntimeCheck("edge"));
  } catch (error) {
    return NextResponse.json(
      {
        error: formatRouteError(error),
        runtime: "edge",
        success: false,
      },
      { status: 500 },
    );
  }
}
