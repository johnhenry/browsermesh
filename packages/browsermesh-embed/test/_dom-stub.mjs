// _dom-stub.mjs — minimal hand-rolled DOM stub for browsermesh-embed's
// widget tests. No jsdom/happy-dom anywhere in this repo (family
// convention is vendored minimal stubs) — this is a slightly richer sibling
// of browsermesh-apps/test/_setup-globals.mjs's `document` stub, scoped to
// this package, because the widget needs real nested appendChild/
// textContent/classList/addEventListener+dispatch/attachShadow, which that
// stub's createElement() doesn't support.

function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    _text: '',
    _listeners: new Map(),
    get textContent() { return this._text },
    set textContent(v) { this._text = String(v); this.children = [] },
    classList: {
      _set: new Set(),
      add(...names) { for (const n of names) this._set.add(n) },
      remove(...names) { for (const n of names) this._set.delete(n) },
      contains(n) { return this._set.has(n) },
    },
    setAttribute(k, v) { this[`attr_${k}`] = String(v) },
    getAttribute(k) { return this[`attr_${k}`] ?? null },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i !== -1) this.children.splice(i, 1)
      return child
    },
    remove() { this.parentNode?.removeChild(this) },
    querySelector() { return null },
    addEventListener(type, fn) {
      const list = this._listeners.get(type) || []
      list.push(fn)
      this._listeners.set(type, list)
    },
    dispatchEvent(evt) {
      for (const fn of this._listeners.get(evt.type) || []) fn(evt)
      return true
    },
    attachShadow() { return (this.shadowRoot = makeElement('#shadow-root')) },
  }
  return el
}

function findById(node, id) {
  if (!node) return null
  if (node.id === id) return node
  for (const child of node.children || []) {
    const found = findById(child, id)
    if (found) return found
  }
  return null
}

/** Install a fresh `document` stub on globalThis and return its `body`. */
export function installDomStub() {
  const body = makeElement('body')
  globalThis.document = {
    body,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => findById(body, id),
  }
  return body
}

export { makeElement }
