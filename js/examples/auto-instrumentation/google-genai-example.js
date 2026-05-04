/**
 * Google GenAI Auto-Instrumentation Example
 *
 * This example demonstrates using Google GenAI SDK with Braintrust auto-instrumentation.
 * Gemini API calls will be automatically traced.
 *
 * Run with: npm run google
 * Or: node --import @braintrust/auto-instrumentations/hook.mjs google-genai-example.js
 */

import { initLogger } from "braintrust";
import { GoogleGenAI } from "@google/genai";

// Check for required API keys
if (!process.env.GOOGLE_GENAI_API_KEY) {
  console.error("Error: GOOGLE_GENAI_API_KEY environment variable is not set.");
  console.error("Please create a .env file with your API key.");
  console.error("Get your API key from: https://aistudio.google.com/apikey");
  process.exit(1);
}

// Initialize Braintrust logging
initLogger({
  projectName: "auto-instrumentation-examples",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

// Create Google GenAI client
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY });

async function main() {
  console.log("Making Google Gemini request...");

  // This call will be automatically traced to Braintrust
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: "Explain what Gemini models are in one sentence.",
  });

  console.log("\nResponse:", response.text);
  console.log("\n✅ Request automatically traced to Braintrust!");
}

main().catch(console.error);
