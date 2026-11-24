---
"@johnhenry/browsermesh-transport": patch
---

When a WebRTC connection fails and no ICE servers are configured, log a one-time note explaining that only host candidates were tried and how to supply `iceServers` (or opt in to `PUBLIC_STUN_SERVERS`). The README now documents why no third-party STUN server is used by default. The default itself (no ICE servers) is unchanged.
