# gossip-protocol

WebRTC peer-to-peer networking (`PartialMesh`) plus a small gossip layer (`GossipProtocol`) for broadcast and direct messaging over a partial mesh.

This package is intentionally small:

- The library exports `PartialMesh`, a best-effort WebRTC partial-mesh connection manager.
- The library exports `GossipProtocol`, a small application-layer helper for gossip broadcast and routed direct messages.
- The current routing model includes membership convergence via gossip, XOR-routed direct messages, and fan-out scaling via $\lceil \log_2(N+1) \rceil$.

Research note:

- CECR, Convergent Extremal Coordinate Routing, is research derived from this work and documents a broader routing model that extends beyond the current implementation: https://gist.github.com/draeder/ac0405667048fcec10b4c8408f1cc768

What is implemented today:

- In-band membership gossip so peers gradually converge on a larger shared peer set than their immediate connections.
- Gossip broadcast with adaptive fan-out based on estimated network size.
- XOR-routed direct messages that can traverse intermediate peers.

What is not implemented today:

- Extremal coordinate embedding using global min/max.
- Coordinate-proximity routing decisions.
- Formal CECR stability logic around stale extrema and bounded drift.

## Install

```bash
npm i gossip-protocol
```

Notes:

- Designed for browsers (WebRTC required). Node.js is used for tooling/tests.
- Signaling uses FreeRTC; by default the demo points at a public server.

## Quick start

```js
import { PartialMesh, GossipProtocol } from 'gossip-protocol';

const mesh = new PartialMesh({
	sessionId: 'my-room',
	minPeers: 1,
	maxPeers: 5,
});

const gossip = new GossipProtocol(mesh, { maxHops: 5, maxDirectHops: 20 });
gossip.on('messageReceived', ({ message, local }) => {
	console.log(local ? 'local' : 'remote', message);
});

gossip.on('directMessageReceived', ({ message }) => {
	console.log('direct message', message.from, '->', message.to, message.data);
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
// gossip.broadcast('hello');
// gossip.sendDirect(targetPeerId, 'private message');
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
- `iceServers` (default `null`): passed to WebRTC for ICE. `null` uses FreeRTC defaults.
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
- `getGlobalPeers(): string[]`
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
- `mesh:membership` → `peers: string[]` emitted when the converged global peer set changes

### `new GossipProtocol(mesh, options?)`

Configuration:

- `maxHops` (default `5`): base maximum hops for broadcast gossip.
- `maxDirectHops` (default `20`): maximum hops for a direct/routed message before it is dropped.

Behavior:

- Broadcast fan-out scales with estimated network size using $\max(2, \lceil \log_2(N+1) \rceil)$.
- Broadcast max hops is also scaled upward based on estimated network size.
- Direct messages are routed toward the connected peer with the smallest XOR distance to the target peer ID.

Methods:

- `broadcast(data: unknown, metadata?: Record<string, unknown>): string`
	- Broadcasts an application payload through the partial mesh and returns the message ID.
- `sendDirect(targetPeerId: string, data: unknown): string | null`
	- Sends a direct message toward `targetPeerId` through the mesh and returns the message ID, or `null` if the local peer ID is not ready.
- `getStats(): GossipStats`
- `cleanup(maxAgeMs?: number): void`
- `destroy(): void`
- `on(event, handler): void` / `off(event, handler): void`

Events:

- `messageReceived` → `{ message: GossipMessage, local: boolean, fromPeer?: string }`
- `directMessageReceived` → `{ message: DirectMessage }`
- `peerConnected` → `{ peerId: string }`
- `peerDisconnected` → `{ peerId: string }`

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

The Vue demo currently includes:

- editable signaling server, network name, room/session ID, min/max peers
- adaptive gossip status display
- network graph of direct connections
- broadcast chat
- direct-message UI backed by routed DMs

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
- Membership convergence is eventually consistent. A peer may temporarily know about fewer peers than another peer.
- The current implementation is CECR-inspired, but does not yet implement coordinate embedding or extrema-based routing.
