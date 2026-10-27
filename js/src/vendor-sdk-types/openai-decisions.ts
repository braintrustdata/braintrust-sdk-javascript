/** Minimal OpenAI Decisions API types (openai >=7.30.0). */
export type OpenAIDecisionQuestion = {
  name?: string;
  instructions: string;
} & (
  | { type: "predicate" }
  | {
      type: "choice";
      choices: { value: string | boolean; description?: string }[];
    }
  | {
      type: "score";
      levels: { label: string; description?: string }[];
    }
);

export interface OpenAIDecisionCreateParams {
  model: string;
  input:
    | string
    | {
        role: "user";
        type?: "message";
        content:
          | string
          | (
              | { type: "input_text"; text: string }
              | {
                  type: "input_image";
                  image_url: string;
                  detail?: string | null;
                }
            )[];
      }[];
  questions: OpenAIDecisionQuestion[];
  safety_identifier?: string | null;
}

export interface OpenAIDecision {
  model: string;
  answers: ({ name: string | null } & (
    | { type: "predicate"; probability: number }
    | {
        type: "choice";
        choice: string | boolean;
        confidence: number;
        probabilities: { value: string | boolean; probability: number }[];
      }
    | {
        type: "score";
        score: number;
        confidence: number;
        probabilities: { value: number; label: string; probability: number }[];
      }
    | { type: "refusal" }
  ))[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens: number;
      cache_write_tokens: number;
    };
    output_tokens_details?: { reasoning_tokens: number };
  };
}

export interface OpenAIDecisionsClient {
  decisions?: {
    create(
      params: OpenAIDecisionCreateParams,
      options?: unknown,
    ): Promise<OpenAIDecision>;
  };
}
