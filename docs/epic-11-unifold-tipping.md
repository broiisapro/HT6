# Epic 11 — Unifold Live Tipping
## Goal
Add a demo-safe live tipping path so audience tips can trigger a musical accent during performance, while preserving the existing biometric tempo, pencil melody, and mood behavior.
## Unifold deposit flow used in this demo
The audience flow is implemented in `tipping/index.html` as a plain HTML/JS page (no build step). It opens a hosted Unifold guided deposit URL in a new tab and appends explicit demo-safe parameters (`mode=test`, `sandbox=true`) before launch.

The page is configured to use a fixed destination wallet address for the run (`recipientAddress` field), and tip amount/token defaults to `2.50 USDC`.

Unifold integration notes used here:
- Use test credentials and environments (`pk_test_...` / `sk_test_...`) for demo safety.
- Use Unifold’s guided hosted flow URL supplied from the dashboard in sandbox/test mode.
- On return, this page inspects callback query params and treats success-like values (`success`, `confirmed`, `completed`, etc.) as a confirmed deposit event.
## New `tip` message shape and meaning
New message emitted by `tipping/index.html` to the existing WebSocket server:
```json
{ "type": "tip", "amount": 2.50, "token": "USDC", "timestamp": 1737000000000 }
```

Fields:
- `type`: fixed `"tip"`.
- `amount`: positive numeric tip amount (display units).
- `token`: token symbol.
- `timestamp`: client emission time in epoch milliseconds.
## Confirmation that audio-engine change was additive-only
`audio-engine/` was changed in exactly one place: one new `if (message.type === "tip")` branch inside the existing dispatch block in `audio-engine/src/server.js`.

What this branch does:
- Validates `amount` is positive.
- Logs the confirmed tip.
- Triggers a short double-hit accent by reusing existing `playBeat(...)` synthesis callbacks.

What was not changed:
- No edits to biometric handling.
- No edits to pencil handling.
- No edits to mood classification logic.
- No structural refactor of dispatch.
## Manual simulate-tip fallback and why it is required
`tipping/index.html` includes two explicit fallback triggers that send the exact same `tip` message shape as a real confirmation:
- `Simulate Tip (Fallback)` button.
- Keyboard shortcut `T`.

This fallback guarantees the live demo can always trigger the audible accent even if on-chain confirmation is delayed, network conditions degrade, or the hosted flow is unavailable.
## Key decisions and rationale
- Accent sound choice: reused existing `playBeat` synthesis path in `audio-engine` to keep the engine diff additive-only and avoid introducing new assets or DSP chains late in demo prep.
- Confirmation strategy: support callback-based auto-send from return URL params, plus operator-controlled manual confirmation fallback.
- Safety strategy: force test/sandbox flags in launch URL and keep destination address explicit on-page for run visibility.
## Known limitations
- Hosted flow callback parameter names can vary by integration; the page handles common success/status keys but may need small key-name tuning for a specific Unifold dashboard configuration.
- This implementation uses a fixed tip accent shape (double-hit), not dynamic accent intensity by tip amount.
- The client-side callback path assumes the deposit flow returns to this page; webhook-only server-side confirmation is not wired in this epic.
