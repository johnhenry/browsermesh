---
"@johnhenry/browsermesh-netway": patch
---

`GatewayBackend` now follows wsh's `gateway-credit` flow control, so a connection through a current wsh host carries more than the first 256 KiB in each direction. When the host states the feature, writes to the origin go out only as far as the host's credit allows (frames of at most 64 KiB), and credit goes back to the host as the socket's consumer reads, so a consumer that stops reading stops the origin and the data held stays bounded. A wait for credit ends when the host closes the connection, the user destroys the socket, the backend is closed, or the wsh client's transport closes. Against a host that does not state the feature, nothing changes. UDP through the gateway stays send-only, and the README and types now say so.
