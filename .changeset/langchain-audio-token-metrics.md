---
"braintrust": patch
---

fix(langchain): Record audio token metrics from usage metadata

LangChain spans now log `prompt_audio_tokens` and `completion_audio_tokens` from `usage_metadata.input_token_details.audio` and `output_token_details.audio`, matching the Python SDK.
