import OpenAI from "openai";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET() {
  const client = new OpenAI({
    apiKey: "test",
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });

  return Response.json({
    runtime,
    openaiCreate: typeof client.chat.completions.create === "function",
  });
}
