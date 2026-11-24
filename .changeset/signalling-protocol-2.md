---
'@johnhenry/browsermesh-core': minor
'@johnhenry/browsermesh-pod': minor
---

The signalling clients speak the signalling server's authenticated registration (protocol 2).

`SignalingClient` (core) and `WebSocketTransport` (pod, signalling dialect and the `signalingUrl` connection) take an `identity` (a `PodIdentity`, whose `podId` must be the pod id). Against a server in authenticated mode they answer its single-use challenge with a signature over the origin of the URL they were configured with, the pod id and the nonce, so the server can tie the pod id to the key that proves it. Against an open-mode or older server, which sends no challenge, they register as before after a bounded wait (`challengeWaitMs`, default 2000). `authentication: 'required'` never falls back; `'off'` never signs; `origin` overrides the signed origin for a server reached under another name.

Without an identity, against a server that requires protocol 2, they fail with a named `SignalingAuthRequiredError` (and the transport stops retrying a refusal that cannot change). Other refusals are a `SignalingAuthError` carrying the server's own `code`. With no `identity` the existing behaviour is unchanged: `SignalingClient.connect()` still resolves on open (set `waitForRegistration: true` to have it reject on a refusal), and nothing new is sent to a server that does not offer the challenge.

What the server says about a link is surfaced without being promoted: `registration` (`{ mode, verified }`), `SignalingClient.isSourceVerified(message)`, and on `WebSocketTransport` `serverVerifiedPeers` and a `relaySourceVerified` field on each delivered message (true only for a literal `true` set by the server). A server-verified pod is still a hint: it is not a broadcast recipient, which still needs the pod's own signed hello or ack. Open-mode and older servers read as unverified.

`fetchIceServers({ url | signalingUrl, token })` (core) fetches the server's time-limited ICE servers, sending the token as a Bearer header only (never over plain `http` to a non-loopback host, never across a redirect).

An older peer is unaffected: nothing is added to the open-mode register frame, and the relay dialect is unchanged.
