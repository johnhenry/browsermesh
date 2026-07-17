/**
 * injected-pod.mjs — Lightweight pod for injection into arbitrary pages.
 *
 * Extends Pod with page-context capabilities: text extraction, structured
 * data extraction, and a visual overlay indicator. Designed for Chrome
 * extension injection or bookmarklet use.
 */

import { Pod } from './pod.mjs'

const OVERLAY_ID = '__pod_overlay__'

export class InjectedPod extends Pod {
  #extensionBridge = null

  /**
   * @param {object} [opts]
   * @param {object} [opts.extensionBridge] - Chrome extension port for relaying
   */
  constructor(opts = {}) {
    super()
    this.#extensionBridge = opts.extensionBridge || null
  }

  /** Page context: URL, title, origin, favicon */
  get pageContext() {
    const g = this._getGlobal()
    if (!g?.document) return null
    return {
      url: g.location?.href || '',
      title: g.document.title || '',
      origin: g.location?.origin || '',
      favicon: g.document.querySelector('link[rel~="icon"]')?.href || '',
    }
  }

  /**
   * Extract visible text content from the page.
   * @returns {string}
   */
  extractText() {
    const g = this._getGlobal()
    if (!g?.document?.body) return ''
    return g.document.body.innerText || ''
  }

  /**
   * Extract structured page data.
   * @returns {object}
   */
  extractStructured() {
    const g = this._getGlobal()
    if (!g?.document) return {}

    const doc = g.document
    const metas = {}
    for (const el of doc.querySelectorAll('meta[name], meta[property]')) {
      const key = el.getAttribute('name') || el.getAttribute('property')
      if (key) metas[key] = el.getAttribute('content') || ''
    }

    const headings = []
    for (const el of doc.querySelectorAll('h1, h2, h3')) {
      headings.push({ tag: el.tagName.toLowerCase(), text: el.textContent?.trim() || '' })
    }

    return {
      title: doc.title || '',
      url: g.location?.href || '',
      meta: metas,
      headings,
    }
  }

  /**
   * Show a floating overlay indicator on the page.
   * Blue circle (48px) fixed at bottom-right with "Pod" label.
   */
  showOverlay() {
    const g = this._getGlobal()
    if (!g?.document) return

    if (g.document.getElementById(OVERLAY_ID)) return

    const el = g.document.createElement('div')
    el.id = OVERLAY_ID
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      width: '48px',
      height: '48px',
      borderRadius: '50%',
      background: '#3b82f6',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '12px',
      fontWeight: 'bold',
      fontFamily: 'system-ui, sans-serif',
      zIndex: '2147483647',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      userSelect: 'none',
    })
    el.textContent = 'Pod'
    el.title = `Pod: ${this.podId?.slice(0, 8) || 'booting'}`
    g.document.body.appendChild(el)
  }

  /** Hide the overlay indicator. */
  hideOverlay() {
    const g = this._getGlobal()
    if (!g?.document) return
    const el = g.document.getElementById(OVERLAY_ID)
    if (el) el.remove()
  }

  _onReady() {
    this.showOverlay()
  }

  _onMessage(msg) {
    // Forward to extension bridge if available
    if (this.#extensionBridge && typeof this.#extensionBridge.postMessage === 'function') {
      this.#extensionBridge.postMessage(msg)
    }
    this.emit('pod:message', msg)
  }

  /** Emit helper for subclass/external use — dispatches through the same
   *  listener registry that on()/off() populate. */
  emit(event, data) {
    this._emit(event, data)
  }

  /** @internal — access the global reference set during boot */
  _getGlobal() {
    // During boot, Pod stores g internally. For InjectedPod pre-boot, use globalThis
    return globalThis
  }

  async shutdown(opts = {}) {
    this.hideOverlay()
    await super.shutdown(opts)
  }
}
