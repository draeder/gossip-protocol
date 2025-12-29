# partialmesh + gossip demo

WebRTC peer-to-peer partial mesh networking library (`PartialMesh`) plus a small Vue 3 demo app that uses a simple gossip protocol to propagate messages.

## Purpose

- `PartialMesh` maintains a best-effort set of WebRTC peer connections (partial mesh or ring topology) with configurable `minPeers`/`maxPeers`.
- The Vue demo shows how to broadcast messages across the mesh using a gossip-style re-propagation strategy.

## Run the demo

From the repo root:

- Install: `npm install`
- Start the Vue3 demo dev server: `npm run dev`
	- Serves at `http://127.0.0.1:5173`

The demo auto-starts the mesh if you open it with query params like:

- `/?autostart=1&maxPeers=20&minPeers=3&topology=partial&sessionId=your-room`

## Tests (default: 5-run loop)

`npm test` runs the Playwright e2e spec in a loop and prints a per-run summary at the end.

Defaults (in [scripts/run-e2e-loop.mjs](scripts/run-e2e-loop.mjs)):

- Runs: 5
- Timeout: 15s per test (`--timeout`)
- Reporter: `dot` (acts like a progress indicator)
- Spec: `tests/vue3-15-peers-crossbrowser.spec.ts`

### Override loop parameters

Env vars:

- `E2E_RUNS` (number of runs)
- `E2E_TIMEOUT_MS` (per-test timeout)
- `E2E_SPEC` (spec path)
- `E2E_REPORTER` (`dot`, `line`, etc.)
- `E2E_MAX_RUN_SECONDS` (optional hard cap per run)

Examples:

- 10 runs @ 20s: `E2E_RUNS=10 E2E_TIMEOUT_MS=20000 npm test`
- Different spec: `E2E_SPEC=tests/vue3-15-peers-crossbrowser.spec.ts npm test`

CLI flags (alternative to env vars):

- `node scripts/run-e2e-loop.mjs --runs=5 --timeoutMs=15000 --spec=tests/vue3-15-peers-crossbrowser.spec.ts --reporter=dot`

## What the e2e spec validates

The spec is message-focused:

- Spins up 5 Chromium + 5 WebKit + 5 Firefox peers in the same signaling session.
- Sends one chat message from a single peer.
- Asserts that the message propagates to multiple peers across engines within the test timeout.

Console noise is intentionally minimized (ICE candidate spam is suppressed).

## Notes / Risks

- WebRTC automation is inherently flaky across engines; timeouts and thresholds are tuned for stability, not strict guarantees.
- This repo uses an external signaling service (`wss://signal.peer.ooo`). That introduces availability and privacy/metadata considerations (room IDs, timing, and client IDs are visible to the signaling layer).
- Do not treat this as a security boundary. If you need authenticated peers, authorization, encryption at the application layer, rate limiting, abuse protection, or persistence, you’ll need to add those.
