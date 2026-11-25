---
'@johnhenry/browsermesh-apps': minor
---

`createMeshNode()` accepts `maxHalfOpenInbound` and `halfOpenTimeoutMs` and passes them to its WebRTC transport factory
(as `createWebRTCTransportFactory()` already took them). Leaving them out keeps the factory's defaults (64 connections,
60 000 ms); `Infinity` turns either bound off.
