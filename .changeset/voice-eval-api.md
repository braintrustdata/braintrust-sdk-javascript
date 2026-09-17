---
"braintrust": minor
---

feat: Add `braintrust/voice`, an implementation of the Voice Eval SDK API proposal

Adds `newRoom()`, `getActor()`, and the `Room` / `Actor` / `Call` / `Conversation` / `VoiceTurn` types for driving a voice agent under test with a simulated caller.

Deliberately adds no scoring surface and no change to `Eval`: `room.listen()` returns a `Conversation`, the task returns it as its output, and scorers read `args.output` as they always do. A voice eval is an ordinary eval whose output happens to be a conversation.

Backends sit behind a `VoiceBackend` seam. `HttpVoiceBackend` marks where a hosted control plane would attach; `replayBackend` is a labelled local fake that scripts the caller's side while the agent under test answers for real.
