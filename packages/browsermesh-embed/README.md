# browsermesh-embed

Embeddable agent-backed workspace pod — drop an interactive agent into any
web app.

`EmbeddedPod` extends `@johnhenry/browsermesh-pod`'s `Pod` with a minimal
messaging API (`sendMessage`, `on`/`off`/`emit`) and a lazy-attached agent
slot, so a host app can wire up its own agent implementation and drive it
through a stable embedding surface. The agent is duck-typed (`sendMessage`,
`getEventLog().query()`, `run()`) — this package has no dependency on any
specific agent implementation.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/clawser-embed`), where it was manually published to npm, unscoped, as `clawser-embed@0.1.1` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Install

```bash
npm install @johnhenry/browsermesh-embed @johnhenry/browsermesh-pod
```

## Usage

```js
import { EmbeddedPod } from '@johnhenry/browsermesh-embed'

const pod = new EmbeddedPod({ containerId: 'my-agent', agent: myAgent })

pod.on('response', (msg) => console.log(msg))

const { content, toolCalls } = await pod.sendMessage('Summarize this page')
```

`config.agent` accepts any object implementing `sendMessage(text, opts)`,
`getEventLog().query({ type })`, and `run()` — see `src/index.mjs` for the
exact contract `sendMessage()` relies on.

## Backward compatibility

`ClawserEmbed` is exported as an alias of `EmbeddedPod` for callers migrating
from an earlier naming.
