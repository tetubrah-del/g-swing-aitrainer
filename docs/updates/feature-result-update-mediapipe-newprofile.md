Update: feature/result-update-mediapipe-newprofile

- Add swing analyzer profile (pose + on-plane metrics) helpers for LLM guidance.
- Inject swing analyzer metrics into LLM prompts (calm tone, fixed structure).
- Apply analyzer-based adjustments to downswing scoring (outside-in, hand-vs-chest).
- Provide analyzer context in phase reanalysis prompts.
- Add MediaPipe-based outside-in proxy metrics and prefer them in UI and profiles.
- Normalize outside-in wording and enforce analyzer/phase consistency.
- Add PRO-only AI coach commentary under swing analyzer metrics (LLM output `analyzer_comment`).
