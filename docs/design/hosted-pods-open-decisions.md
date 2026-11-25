# Hosted pods: the decisions that are the owner's

Part of [#185](https://github.com/johnhenry/browsermesh/issues/185) and
[#221](https://github.com/johnhenry/browsermesh/issues/221). Everything in those issues that can be built and tested
without a decision or a machine this repository does not have has been. What is left is here: for each item, the state
today, the options, a recommendation, and what each option takes. Nothing below has been decided; the repository's
defaults are the conservative ones (nothing on by default, nothing published, nothing deployed).

Written 2026-11-24 against `main`. Where a claim was checked, how is said; where it was not, that is said too.

## 1. Durable Object hibernation (the isolate lane, Cloudflare)

**Decided 2026-11-25: B, built in process** (what sleep and wake do, the bounds, the placement and supervisor
interplay: [`../hosted-pods.md`](../hosted-pods.md#44-hibernation-cold-boot-as-sleep)). Left for the owner: on a
deployed Worker, measure `wakeMs` with the shortened `discoveryWindowMs` and the memory per idle pod; move to C only if
that number is too slow for a use that needs a pod addressable while asleep.

**State.** `spikes/isolate-pod-host` runs a pod in a Durable Object that dials out to the relay and the signalling
server. Cloudflare's WebSocket Hibernation only covers sockets a Durable Object *accepts* as a server, and an open
outbound socket keeps the object in memory (the spike's README quotes the platform's documentation for both). So "a
sleeping pod that wakes on a message" costs a cold boot, measured at about 1.5 s on `cf dev`, almost all of it
`TransportDiscovery`'s fixed discovery window rather than the network. Nothing is deployed; the isolate lane's runtime
that exists today is `createIsolatedVmRuntime()` (an optional native addon, tested on macOS and Linux) and self-hosted
`workerd`.

| Option | What it is | What it takes | Cost of choosing it |
| --- | --- | --- | --- |
| A. Leave it | The pod keeps its outbound connections and stays in memory while it is up. | Nothing. | No sleeping pods in this lane; billing for the whole time a pod is up. |
| B. Cold boot is the sleep | Let the object be evicted when idle; the first message boots it again. Shorten the discovery window for a hosted pod (the 1.5 s is a fixed wait, not a connection cost) and measure. | A measurement: `discoveryTimeout` set small in `spikes/isolate-pod-host`, boot to registered timed again. Hours. | A wake is a boot, but if boot is tens of milliseconds that may be all "sleeping" needs to mean. Messages that arrive while it is asleep need somewhere to wait (the relay does not queue). |
| C. Peers dial the Durable Object | The object accepts peers' WebSockets and can hibernate between messages. | A new connection dialect for a hosted pod (peers need its URL, not just its pod id), an authenticated handshake on it (the signed hello, or a wsh link served from the object), a registry from pod id to URL, and a client in `WebSocketTransport`. Roughly one to two weeks including a spike, and it needs a real Cloudflare account to measure the number that matters (wake under 50 ms). | The "no new servers" property of this lane goes; the relay becomes optional for it. |
| D. The relay dials the Durable Object | The relay acts as a WebSocket client to registered hosted pods. | A change to the relay in `browsermesh-servers` (a registration that carries a URL, authentication in both directions) and the same object-side work as C. | A server change in the sibling repository that every deployment of it would take. |

**Recommendation.** B first: it is the cheapest, it answers whether the problem exists, and it changes nothing on the
wire. Move to C only if a use needs a pod that is addressable while asleep and a measured cold boot is too slow. Do not
do D without a reason that C does not cover, since it changes a server other people run. Whatever is chosen, the wake
number and the memory per idle pod can only be measured on a deployed Worker, which is the owner's account.

## 2. Publishing `@johnhenry/browsermesh-meshctl`

**State.** `private: true`; not in `scripts/staggered-publish.sh`. The name is free on npm (`npm view` answers 404 for
it, checked 2026-11-24). Until PR #361 the package could not start outside this repository (a static import of
`spikes/vm-pod-host`, so every command failed with `ERR_MODULE_NOT_FOUND` in the packed package; checked by packing it
and running it). Reaching a host through a relay now works with a sealed link (`--wsh-relay`, PR #356, against the
in-process pipe relay). The WebRTC path is wired but has not been exercised end to end, and no deployed host exists to
talk to.

| Option | What it takes | Cost of choosing it |
| --- | --- | --- |
| A. Stay private | Nothing. | Used only through the repository (`npx meshctl` in a checkout). |
| B. Publish as 0.1.x now | Remove `private`; add the package to `scripts/staggered-publish.sh` after apps, transport and pod; a changeset; raise the optional `@johnhenry/browsermesh-transport` peer to the release that has the `/wsh` subpath (0.11); say in the README that `vm` needs a checkout. The release then goes through the usual version PR. About an hour of mechanical work. | A public CLI whose real-mesh path has never been run end to end; anyone reading the README will try it. |
| C. Publish after one real run | The steps of B, after the owner has run `meshctl` against one deployed host over `--wsh-relay` (and WebRTC, if that is to be claimed) and recorded it. | A wait for a deployment. |

**Recommendation.** C, with B's steps ready. The package is small (16 files, about 31 kB packed) and self-contained now;
what is missing is evidence from outside the test suite. Releases stop at a major: this would be a first minor.

## 3. The MV3 extension spike

**Decided 2026-11-25: option A, done.** The spike has been removed; what was learned (why it did not run, what a
working extension would need) is in [`../hosted-pods.md`](../hosted-pods.md#what-was-learned-from-the-mv3-extension-spike).
The text below is the state and options as they were when the decision was asked.

**State.** The extension spike was frozen (its `exec` evaluated a string in a page, which cannot work under a
strict Content-Security-Policy), and #272 asked whether to retire it. Loaded by hand with Playwright and the Chromium
that is already installed, following its README's "Load unpacked", **the extension did not run.** Its service worker
started and exited at once, with no error shown on the extensions page. The cause was isolated: a worker with a trivial
`background.mjs` stays up, and a worker whose `background.mjs` imports a file outside the extension directory (as the
spike's did) dies the same way, because an unpacked extension cannot
import files outside its own root. The pod package also imports by bare package name, which an extension worker cannot
resolve without a bundle. So nothing written about the extension's behaviour had been observable in a browser; only the
driver, against a fake `chrome`, had ever run.

| Option | What it takes | Cost of choosing it |
| --- | --- | --- |
| A. Retire it | Delete the spike and its README section, drop the extension driver from `docs/hosted-pods.md` section 8b, replace the frozen-spike test with one that fails on a leftover reference. An hour. | The browser lane has two drivers (in-page and CDP) instead of three. |
| B. Make it load | Bundle the worker and the pod package into the extension directory (a build step the repository does not have today), set `host_permissions` to a real origin, then add a Playwright test that loads it and drives `spawn` and `exec`. One to two days. | You then own an extension with `scripting` access whose `exec` is `eval`: the reason it was frozen. |
| C. Replace it | Serve the remote-object layer from the page (`@johnhenry/wsh/objects`, `examples/19-wsh-objects-over-protocol-channel.mjs`) and let an extension, if one is wanted at all, only inject that. | Larger; a design of its own. |

**Recommendation.** A. The frozen note already says why not to build on it, and the one thing a real browser could still
tell us (does it load) is now answered.

## 4. Accepting an unauthenticated relay path

The issue allowed "an explicit decision to accept an unauthenticated relay path" as the alternative to a sealed link.
It is not needed: the sealed link exists and meshctl uses it (`--wsh-relay`). The relay dialect of `WebSocketTransport`
stays unused for pod-host traffic: that relay reads every envelope and its `register` frame proves no key. **Recommendation:
do not accept it.** If a deployment wants it, it is a flag and a statement in the README, a few hours; this repository
does not ship it.

## 5. Deploying the isolate lane

**State.** Not deployed anywhere (and no deployed hosted-pod service was contacted while writing this). The options are self-hosted `workerd`
(`spikes/isolate-pod-host/workerd.config.capnp` exists) on a machine the owner runs, Cloudflare Workers (which is where
section 1 matters), or the `isolated-vm` runtime inside a Node host (tested on macOS arm64, Linux arm64 and x64
emulated, glibc and musl; not tested on native x64 hardware, built from source, or against an exploit attempt).
**Recommendation:** the `isolated-vm` runtime in a Node host first (nothing new to operate), and treat Cloudflare as a
second backend after section 1 is settled.

## 6. The microVM guest's Node version

`guest/build-rootfs.sh` installs Alpine's `nodejs`: 20.15.1 on its default Alpine 3.20, 24.x on 3.23 (checked against
Alpine's package indexes; only `edge` has 26), while the packages declare Node 26 or later. The script now takes
`ALPINE_VERSION` and `ALPINE_RELEASE` and prints the version it installed; the default is unchanged. Which Node the guest
runs is decided by the first boot on a KVM host (`runbook-firecracker-kvm.md`); **recommendation:** build with 3.23
there, and move the script's default if it works.
