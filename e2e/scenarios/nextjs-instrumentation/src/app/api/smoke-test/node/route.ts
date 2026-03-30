import { NextResponse } from "next/server";
import {
  formatRouteError,
  runRuntimeCheck,
} from "../../../../lib/runtime-check";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await runRuntimeCheck("nodejs"));
  } catch (error) {
    return NextResponse.json(
      {
        error: formatRouteError(error),
        runtime: "nodejs",
        success: false,
      },
      { status: 500 },
    );
  }
}
