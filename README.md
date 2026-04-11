# gossip-protocol

WebRTC peer-to-peer networking (`PartialMesh`) plus an example “gossip protocol” implementation that re-propagates messages across connected peers.

This package is intentionally small:

- The library exports `PartialMesh` (best-effort WebRTC partial mesh connection manager).
- The library also exports `GossipProtocol`, a tiny re-propagation helper used by the demo.

## Install

```bash
npm i gossip-protocol
```

Notes:

- Designed for browsers (WebRTC required). Node.js is used for tooling/tests.
- Signaling uses UniWRTC; by default the demo points at a public server.

## Quick start

```js
import { PartialMesh, GossipProtocol } from 'gossip-protocol';

const mesh = new PartialMesh({
	sessionId: 'my-room',
	minPeers: 1,
	maxPeers: 5,
});

const gossip = new GossipProtocol(mesh, { maxHops: 5 });
gossip.on('messageReceived', ({ message, local }) => {
	console.log(local ? 'local' : 'remote', message);
});

mesh.on('signaling:connected', ({ clientId }) => {
	console.log('signaling connected as', clientId);
});

mesh.on('peer:connected', (peerId) => {
	console.log('peer connected', peerId);
});

mesh.on('peer:data', ({ peerId, data }) => {
	console.log('from', peerId, data.toString());
});

await mesh.init();

// Later:
// mesh.broadcast('hello');
// mesh.send(peerId, 'direct message');
// mesh.destroy();
```

## API

### `new PartialMesh(config?)`

Configuration (all optional):

- `minPeers` (default `2`): minimum number of peer connections to maintain.
- `maxPeers` (default `10`): maximum number of peer connections to maintain.
- `signalingServer` (default `wss://peer.ooo/ws`): FreeRTC signaling server URL.
- `sessionId` (default `default-session`): room ID used for discovery.
- `autoDiscover` (default `true`): automatically join `sessionId` on signaling connect.
- `autoConnect` (default `true`): automatically converge to the target connection count.
- `iceServers` (default: Google STUN): passed to WebRTC for ICE.
- `connectionTimeoutMs` (default `25000`): time to wait for a peer to reach `connect` before retrying.
- `maintenanceIntervalMs` (default `2000`): how often to run the convergence loop.
- `underConnectedResetMs` (default `0` / disabled): if > 0, triggers a periodic `hardReset()` when the mesh stays below `minPeers` despite having enough discovered peers.

### Methods

- `init(): Promise<void>`
	- Connects to signaling, joins the discovery session (if `autoDiscover`), and starts maintenance (if `autoConnect`).
- `destroy(): void`
	- Tears down peer connections, clears discovered peers, and disconnects signaling.
- `hardReset(reason?: string): void`
	- Drops all peer connections but keeps signaling/discovery state; useful to recover from rare stuck negotiation/ICE states.
- `connectToPeer(peerId: string): void`
	- Attempts to establish a WebRTC connection to a discovered peer.
- `disconnectFromPeer(peerId: string): void`
	- Disconnects from a peer (does not remove it from discovery unless signaling says it left).
- `send(peerId: string, data: string | Buffer | ArrayBuffer): void`
	- Sends data to a connected peer. Throws if not connected.
- `broadcast(data: string | Buffer | ArrayBuffer): void`
	- Sends data to all connected peers.
- `getConnectedPeers(): string[]`
- `getDiscoveredPeers(): string[]`
- `getPeerCount(): number`
- `getClientId(): string | null`
- `on(event, handler): void` / `off(event, handler): void`

### Events

- `signaling:connected` → `{ clientId: string, rawClientId?: string }`
- `signaling:disconnected`
- `signaling:error` → `any`
- `peer:discovered` → `peerId: string`
- `peer:connected` → `peerId: string`
- `peer:disconnected` → `peerId: string`
- `peer:data` → `{ peerId: string, data: any }` (typically a Buffer-like payload)
- `peer:error` → `{ peerId: string, error: any }`
- `mesh:ready` → emitted when `connectedPeers.length >= minPeers`

## Vue 3 demo (gossip)

From the repo root:

```bash
npm install
npm run dev
```

Serves at `http://127.0.0.1:5173`.

Autostart parameters:

- `autostart=1`
- `maxPeers=20`
- `minPeers=3`
- `sessionId=your-room`

Example:

`http://127.0.0.1:5173/?autostart=1&maxPeers=10&minPeers=2&sessionId=my-room`

## Tests (Playwright e2e loop)

`npm test` runs a Playwright spec in a loop and prints a per-run summary.

Defaults are defined in [scripts/run-e2e-loop.mjs](scripts/run-e2e-loop.mjs):

- Runs: `5`
- Spec: `tests/vue3-15-peers-crossbrowser.spec.ts`

Override via env vars:

- `E2E_RUNS`
- `E2E_TIMEOUT_MS`
- `E2E_SPEC`
- `E2E_REPORTER`
- `E2E_MAX_RUN_SECONDS`

Examples:

```bash
E2E_RUNS=10 E2E_TIMEOUT_MS=20000 npm test
E2E_SPEC=tests/vue3-15-peers-crossbrowser.spec.ts npm test
```

Or run the loop script directly:

```bash
node scripts/run-e2e-loop.mjs --runs 5 --timeoutMs 15000 --spec tests/vue3-15-peers-crossbrowser.spec.ts --reporter dot
```

## Notes / risks

- WebRTC + browser automation is inherently flaky across engines; timeouts are tuned for stability rather than strict guarantees.
- The default signaling endpoint is a third-party service. Treat room IDs and client IDs as metadata visible to that signaling layer.
- This is not a security boundary. If you need authz/authn, abuse protection, persistence, or app-layer encryption, add them in your application.
