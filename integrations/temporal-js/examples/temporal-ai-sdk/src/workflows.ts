import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";

/**
 * Proxy the activities for use in workflows
 */
const { generateTextTraced, generateTextWithToolsTraced } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "1 minute",
});

/**
 * Haiku Agent
 */
export async function haikuAgent(topic: string): Promise<string> {
  return await generateTextTraced({
    modelId: "gpt-4o-mini",
    system: "You only respond in haikus",
    prompt: `Write a haiku about ${topic}`,
  });
}

/**
 * Get weather tool agent
 */
export async function toolsAgent(prompt: string): Promise<string> {
  return await generateTextWithToolsTraced({
    modelId: "gpt-4o-mini",
    prompt,
  });
}
