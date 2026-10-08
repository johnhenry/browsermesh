---
"@johnhenry/browsermesh-transport": minor
"@johnhenry/browsermesh-apps": minor
---

Multiple named data channels over one negotiated WebRTC connection (#115). `WebRTCPeerConnection#openChannel(name, { ordered, maxRetransmits, maxPacketLifeTime })`, `closeChannel(name)` and `channels` add independent SCTP streams (no new ICE/DTLS handshake); `send(data, { channel: name })` addresses them (no fallback to control for an unknown or closed name), the remote adopts them automatically, and `onMessage` callbacks receive the channel name as a second argument. `WebRTCTransportAdapter` forwards these, and `PeerNode.sendTo` / `broadcast` accept a named channel the session's transport has opened. Open named channels only to peers on a build that has this: older builds adopt an unrecognised label as their control channel.
