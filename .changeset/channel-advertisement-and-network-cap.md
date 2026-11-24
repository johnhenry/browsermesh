---
"@johnhenry/browsermesh-apps": minor
"@johnhenry/browsermesh-netway": minor
---

apps: `channelAdvertisement()`, `readChannelAdvertisement()`, `advertisedProtocolSupport()` and `peerSupportsFromAdvertisements()` (`@johnhenry/browsermesh-apps/channel-advertisement`) let a peer say, and another learn without a handshake, that it runs the message channel and which layered protocols and versions it serves; a peer that advertises nothing is still tried. netway: `new VirtualNetwork({ maxBufferedBytes })` caps the bytes held unread or unsent by the sockets its `connect()` handed out and refuses new connections with `BufferLimitError` (`ENOBUFS`) while it is reached; off by default.
