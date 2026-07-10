export const CHAT_MATH = {
  id: "chatcmpl-Aao716hWOt9HBihjWh9iAPGWRpkFd",
  object: "chat.completion",
  created: 1733335803,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "1 + 2 equals 3.",
        refusal: null,
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 15,
    completion_tokens: 8,
    total_tokens: 23,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  },
  system_fingerprint: "fp_0705bf87c0",
};

export const CHAT_STREAM_PARROT = [
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"role":"assistant","content":"","refusal":null},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"content":"Pol"},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"content":"ly"},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"content":" wants"},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"content":" more"},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"content":" crackers"},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{"content":"!"},"logprobs":null,"finish_reason":null}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":null}`,
  `data: {"id":"chatcmpl-Ab9p7esnOlnH4ywBeHQOp4ScoCcde","object":"chat.completion.chunk","created":1733419261,"model":"gpt-4o-mini-2024-07-18","system_fingerprint":"fp_0705bf87c0","choices":[],"usage":{"prompt_tokens":16,"completion_tokens":6,"total_tokens":22,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}}}`,
  `data: [DONE]`,
];

export const CHAT_CHAIN_MEMORY = {
  id: "chatcmpl-AbAHIqtiUXMz849pZPWxB7RKF9wPh",
  object: "chat.completion",
  created: 1733421008,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Assistant: I'm called Assistant! How can I help you today?",
        refusal: null,
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 24,
    completion_tokens: 13,
    total_tokens: 37,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  },
  system_fingerprint: "fp_0705bf87c0",
};

export const CHAT_TOOL_CALCULATOR = {
  id: "chatcmpl-AbAVR1TojvbDgXRLlDyhz9NYZVitz",
  object: "chat.completion",
  created: 1733421885,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_G2Qd8HzTMyFUiMafz5H4fBIi",
            type: "function",
            function: {
              name: "calculator",
              arguments: '{"operation":"multiply","number1":3,"number2":12}',
            },
          },
        ],
        refusal: null,
      },
      logprobs: null,
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 93,
    completion_tokens: 24,
    total_tokens: 117,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  },
  system_fingerprint: "fp_0705bf87c0",
};

export const CHAT_BEAR_JOKE = {
  id: "chatcmpl-AbCj2kznx4QsGpaocNir4GWdLYYqj",
  object: "chat.completion",
  created: 1733430416,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          'Why did the bear sit on the log?\n\nBecause it wanted to be a "bear-ly" seated customer! 🐻',
        refusal: null,
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 13,
    completion_tokens: 26,
    total_tokens: 39,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  },
  system_fingerprint: "fp_bba3c8e70b",
};

export const CHAT_BEAR_POEM = {
  id: "chatcmpl-AbClwtnbeqLRiWwoe21On10TRqqsW",
  object: "chat.completion",
  created: 1733430596,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          "In the forest's hush, a shadow moves near,  \nA gentle giant roams, the wise old bear.",
        refusal: null,
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 15,
    completion_tokens: 23,
    total_tokens: 38,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  },
  system_fingerprint: "fp_bba3c8e70b",
};

export const CHAT_SAY_HELLO = {
  id: "chatcmpl-AbFX2khtngBETl7qtntuXawF6RFPt",
  object: "chat.completion",
  created: 1733441204,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello! How can I assist you today?",
        refusal: null,
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 9,
    completion_tokens: 9,
    total_tokens: 18,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  },
  system_fingerprint: "fp_818c284075",
};
