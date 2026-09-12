# browsermesh-embed

Embeddable agent-backed workspace pod — drop an interactive agent into any
web app.

`EmbeddedPod` extends `@johnhenry/browsermesh-pod`'s `Pod` with a minimal
messaging API (`sendMessage`, `on`/`off`/`emit`), a lazy-attached agent slot,
and a real vanilla-DOM widget rendered into `config.containerId`'s element,
so a host app can wire up its own agent implementation and drive it through
a stable embedding surface. The agent is duck-typed (`sendMessage`,
`getEventLog().query()`, `run()`) — this package has no dependency on any
specific agent implementation.

## Widget

Calling `mount()` (or just constructing `EmbeddedPod` when the container
element already exists in the DOM) attaches an open shadow root
(`container.attachShadow({ mode: 'open' })`) to the configured container and
renders a small self-contained widget into it: a status line
(state/role/live peer count, reactive to `Pod`'s own `'ready'`,
`'peer:found'`, and `'peer:lost'` events), a scrollable message log (user
turns, agent turns with tool-call chips, and inline error entries — never an
uncaught rejection), and an input+submit form wired to `sendMessage()`.
`mount()` is idempotent and safe to call from Node/SSR contexts where
`document` doesn't exist (it's simply a no-op there). It is *not* a
`customElements`/Web Component — it renders directly into the existing
`containerId` contract, using the shadow root purely for CSS isolation.

Colors are themeable via `config.theme` (or the shadow DOM's CSS custom
properties directly): `--bm-accent`, `--bm-bg`, `--bm-fg`. `theme: {}` (or
omitting it entirely) falls back to sane defaults.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/clawser-embed`), where it was manually published to npm, unscoped, as `clawser-embed@0.1.1` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Install

```bash
npm install @johnhenry/browsermesh-embed @johnhenry/browsermesh-pod
```

## Usage

```html
<div id="my-agent"></div>
```

```js
import { EmbeddedPod } from '@johnhenry/browsermesh-embed'

// If #my-agent already exists in the DOM, the widget mounts automatically.
// Otherwise, call pod.mount() explicitly once the container exists (e.g. in
// an SPA that creates it after this runs).
const pod = new EmbeddedPod({
  containerId: 'my-agent',
  agent: myAgent,
  theme: { accent: '#7c3aed' },
})

// 'response' fires with the same normalized object sendMessage() resolves
// with — this is what the widget's own message log listens to internally.
pod.on('response', (msg) => console.log(msg))

const { content, toolCalls } = await pod.sendMessage('Summarize this page')
```

`config.agent` accepts any object implementing `sendMessage(text, opts)`,
`getEventLog().query({ type })`, and `run()` — see `src/index.mjs` for the
exact contract `sendMessage()` relies on.

## Backward compatibility

`ClawserEmbed` is exported as an alias of `EmbeddedPod` for callers migrating
from an earlier naming.
