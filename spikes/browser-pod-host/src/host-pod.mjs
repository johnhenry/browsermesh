/**
 * host-pod.mjs — `BrowserPodHost`, a `Pod` subclass that owns a real
 * headless Chrome process and drives it with the CDP driver (issue #185
 * item 7, deliverable B). Mirrors `spikes/vm-pod-host/src/host-pod.mjs`'s
 * `VmPodHost`: itself a pod in the mesh, advertising `runtimeClasses`
 * metadata the orchestrator's `runtimePeerToComputeDescriptor()` convention
 * reads, wrapping lifecycle (`start()`/`stop()`) around the lower-level
 * pieces (`launchChrome()`, `connect()`, `createCdpDriver()`).
 */

import { Pod, EventEmitterTransport, NullDiscovery } from '../../../packages/browsermesh-pod/src/index.mjs'
import { launchChrome, connect } from './cdp.mjs'
import { createCdpDriver } from './driver.mjs'

/** Metadata this host advertises to the orchestrator (docs/hosted-pods.md §3, §6, §8b). */
const METADATA = Object.freeze({
  runtimeClasses: ['browser'],
  // Unlike Lane B's `VmPodHost` ('vm-console'), the browser lane has no
  // shell backend -- `exec` here is script evaluation, not a console.
  shellBackend: null,
  deploymentSupport: { canDeploy: true },
})

export class BrowserPodHost extends Pod {
  /** @type {Awaited<ReturnType<typeof launchChrome>>|null} */
  #chrome = null

  /** @type {ReturnType<typeof connect>|null} */
  #cdp = null

  /** @type {import('../../../packages/browsermesh-pod/src/index.mjs').PodHostDriver|null} */
  #driver = null

  #podUrl
  #launchOpts
  #contextPerPod
  #onLog

  /**
   * @param {object} opts
   * @param {string} opts.podUrl - URL of the pod page every spawned pod boots.
   * @param {object} [opts.launch] - Forwarded to `launchChrome()`.
   * @param {boolean} [opts.contextPerPod=true] - Forwarded to `createCdpDriver()`.
   * @param {(msg: string) => void} [opts.onLog]
   */
  constructor({ podUrl, launch = {}, contextPerPod = true, onLog } = {}) {
    super()
    if (!podUrl) throw new Error('BrowserPodHost: podUrl is required')
    this.#podUrl = podUrl
    this.#launchOpts = launch
    this.#contextPerPod = contextPerPod
    this.#onLog = onLog ?? (() => {})
  }

  /** @returns {object} */
  get metadata() { return METADATA }

  /** @returns {import('../../../packages/browsermesh-pod/src/index.mjs').PodHostDriver|null} */
  get driver() { return this.#driver }

  /** @returns {Awaited<ReturnType<typeof launchChrome>>|null} */
  get chrome() { return this.#chrome }

  /**
   * Launch Chrome, connect over CDP, build the driver, and boot this
   * host's own `Pod` identity (EventEmitterTransport + NullDiscovery, the
   * same no-browser-globals-needed pattern `VmPodHost#start()` uses).
   * @returns {Promise<void>}
   */
  async start() {
    this.#chrome = await launchChrome(this.#launchOpts)
    this.#cdp = connect(this.#chrome.wsUrl)
    await this.#cdp.ready()
    this.#driver = createCdpDriver({ cdp: this.#cdp, podUrl: this.#podUrl, contextPerPod: this.#contextPerPod })

    const g = { addEventListener: () => {}, removeEventListener: () => {} }
    await this.boot({
      transport: new EventEmitterTransport(),
      discovery: new NullDiscovery(),
      globalThis: g,
      handshakeTimeout: 0,
      discoveryTimeout: 0,
    })
    this.#onLog(`[browser-pod-host] started: ${this.podId} (chrome pid ${this.#chrome.process.pid}, ${this.#chrome.wsUrl})`)
  }

  /**
   * Tear down the CDP connection, kill Chrome, and shut down this host's
   * own `Pod`.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.#cdp) {
      this.#cdp.close()
      this.#cdp = null
    }
    if (this.#chrome) {
      await this.#chrome.close()
      this.#chrome = null
    }
    if (this.state === 'ready') await this.shutdown({ silent: true })
  }

  /** @returns {object} */
  toJSON() {
    return { ...super.toJSON(), metadata: METADATA }
  }
}
