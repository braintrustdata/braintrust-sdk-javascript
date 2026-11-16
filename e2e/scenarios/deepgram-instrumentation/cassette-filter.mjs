// Deepgram adds a per-client session identifier to each request.
export const redact = [
  "paranoid",
  { redactHeaders: ["x-deepgram-session-id"] },
];
