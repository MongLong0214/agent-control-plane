#!/usr/bin/env node
/**
 * Manual verification tool — NOT a CI test, and not wired into any gate.
 *
 * Proves the half of hscope's claim that a committed unit test cannot: that a *real* Buzz relay
 * live-pushes a channel-scoped (`#h`-tagged) kind-9 event to a subscription carrying a matching
 * `#h`, and does not push it to a subscription that only carries `#p`. `src/buzz/buzz-mention-
 * subscriber.ts`'s own mutation-anchored test proves the subscriber *asks* for `#h` correctly;
 * this script is the other half — proving the relay actually honours that scoping — and it needs
 * no Docker, no Postgres, no Redis and no TLS proxy to do it: it speaks to an already-running
 * relay over the wire, using one already-provisioned member identity's key file.
 *
 * **This publishes one real, signed kind-9 event to whatever relay and channel you point it at.**
 * Run it deliberately, against a relay and channel you are prepared to see one extra event in.
 * There is no default relay, channel or key file — all three are required arguments — specifically
 * so nobody runs this against a real deployment by omission.
 *
 * Usage:
 *   node scripts/probe-buzz-live-push.mjs <wss-relay-url> <channel-id> <private-key-file>
 *
 * The key file holds one 32-byte secret key, hex-encoded, the same shape
 * `BuzzSubscriberIdentityConfig.privateKeyFile`/`hex` encoding expects.
 *
 * What the two rows mean:
 *   - "LIVE PUSH  #h-scoped sub"  — the subscription carrying `#h: [channel]`, the shape this
 *     daemon's subscriber now sends. Expected `true`: the property hscope exists to establish.
 *   - "LIVE PUSH  #p-only  sub"   — the *negative control*, carrying no `#h` at all — the exact
 *     shape the subscriber sent before hscope. Expected `false`. This row is not decoration: a
 *     green `#h` row on its own cannot distinguish "the relay honours channel scoping" from "the
 *     relay pushes every live event to every subscription regardless of filter" — only a
 *     `#p`-only row that receives *nothing* rules the second reading out. If this row ever comes
 *     back `true`, the relay's fan-out has changed and hscope's whole premise needs re-measuring,
 *     not just this script.
 *
 * Both subscriptions run on one socket and both reach EOSE before the event is published, so
 * neither result can be explained by backlog delivery — only a live push, arriving after each
 * subscription's own EOSE, can produce either outcome.
 */
import { readFileSync } from "node:fs";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { makeAuthEvent } from "nostr-tools/nip42";

const [, , relayUrl, channel, keyFilePath] = process.argv;
if (!relayUrl || !channel || !keyFilePath) {
  process.stderr.write(
    "usage: node scripts/probe-buzz-live-push.mjs <wss-relay-url> <channel-id> <private-key-file>\n",
  );
  process.exit(2);
}
if (!relayUrl.startsWith("wss://")) {
  process.stderr.write("probe-buzz-live-push: the relay url must be wss://\n");
  process.exit(2);
}

const hex = readFileSync(keyFilePath, "utf8").trim();
const secretKey = Uint8Array.from(hex.match(/.{2}/gu).map((byte) => parseInt(byte, 16)));
const pubkey = getPublicKey(secretKey);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
    let authed = false;
    ws.addEventListener("message", (message) => {
      const frame = JSON.parse(message.data);
      if (frame[0] === "AUTH" && !authed) {
        authed = true;
        ws.send(JSON.stringify(["AUTH", finalizeEvent(makeAuthEvent(relayUrl, frame[1]), secretKey)]));
        clearTimeout(timer);
        setTimeout(() => resolve(ws), 800);
      }
    });
    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.addEventListener("open", () => {
      setTimeout(() => {
        if (!authed) {
          clearTimeout(timer);
          resolve(ws);
        }
      }, 3_000);
    });
  });

const subWs = await connect();
const received = { hscope: [], pscope: [] };
const eose = { hscope: false, pscope: false };
subWs.addEventListener("message", (message) => {
  const frame = JSON.parse(message.data);
  if (frame[0] === "EVENT" && received[frame[1]]) received[frame[1]].push(frame[2].id);
  if (frame[0] === "EOSE" && frame[1] in eose) eose[frame[1]] = true;
  if (frame[0] === "CLOSED") console.log("CLOSED:", JSON.stringify(frame));
  if (frame[0] === "NOTICE") console.log("NOTICE:", JSON.stringify(frame));
});
// hscope: channel-scoped, the shape the fixed subscriber sends.
subWs.send(JSON.stringify(["REQ", "hscope", { kinds: [9], "#p": [pubkey], "#h": [channel] }]));
// pscope: the negative control — no #h, the shape the subscriber sent before this unit.
subWs.send(JSON.stringify(["REQ", "pscope", { kinds: [9], "#p": [pubkey] }]));
await wait(6_000);
console.log("EOSE hscope:", eose.hscope, " EOSE pscope:", eose.pscope);
const backlogAt = { hscope: received.hscope.length, pscope: received.pscope.length };
console.log("backlog at REQ time  hscope:", backlogAt.hscope, " pscope:", backlogAt.pscope);

const pubWs = await connect();
const event = finalizeEvent(
  {
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", pubkey],
      ["h", channel],
    ],
    content: "[probe] channel-scoped live-push measurement (scripts/probe-buzz-live-push.mjs) — self-addressed, ignore",
  },
  secretKey,
);
let accepted = null;
let okMessage = "";
pubWs.addEventListener("message", (message) => {
  const frame = JSON.parse(message.data);
  if (frame[0] === "OK" && frame[1] === event.id) {
    accepted = frame[2];
    okMessage = frame[3] ?? "";
  }
});
pubWs.send(JSON.stringify(["EVENT", event]));
await wait(4_000);
console.log("published event:", event.id, "accepted:", accepted, okMessage);

await wait(8_000);
console.log("");
console.log(
  "LIVE PUSH  #h-scoped sub (expected true) :",
  received.hscope.slice(backlogAt.hscope).includes(event.id),
);
console.log(
  "LIVE PUSH  #p-only  sub (negative control, expected false):",
  received.pscope.slice(backlogAt.pscope).includes(event.id),
);

const freshWs = await connect();
const fresh = [];
freshWs.addEventListener("message", (message) => {
  const frame = JSON.parse(message.data);
  if (frame[0] === "EVENT" && frame[1] === "fresh") fresh.push(frame[2].id);
});
freshWs.send(JSON.stringify(["REQ", "fresh", { kinds: [9], "#p": [pubkey], "#h": [channel], limit: 10 }]));
await wait(4_000);
console.log("FRESH REQ retrieves it (stored path)       :", fresh.includes(event.id));

subWs.close();
pubWs.close();
freshWs.close();
