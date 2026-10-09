---
"@braintrust/audio": minor
---

feat(audio): add shared progressive audio recordings

Add an optional, framework-independent audio recorder with progressive segmentation, WAV and Ogg/Opus encoding in a worker, and ordinary attachment uploads. Bound source memory and worker admission; publish ready recordings and playback selections only after upload succeeds. Preserve uploaded audio when later capture or trace publication fails.
