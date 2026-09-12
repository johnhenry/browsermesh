// dom.mjs — DOM-building code for EmbeddedPod's widget UI.
//
// Kept separate from index.mjs, mirroring browsermesh-pod's pod.mjs /
// injected-pod.mjs split (state/logic vs. DOM). Framework-free, defensive:
// every function here assumes it's only called once a real `document` and
// container element are known to exist (index.mjs's mount() checks that
// before calling in) but none of it throws if handed odd/missing input.

const DEFAULT_THEME = {
  accent: '#3b82f6',
  bg: '#0b0f1a',
  fg: '#e5e7eb',
}

function buildCss(theme = {}) {
  const t = { ...DEFAULT_THEME, ...theme }
  return `
    .bm-embed {
      --bm-accent: ${t.accent};
      --bm-bg: ${t.bg};
      --bm-fg: ${t.fg};
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 240px;
      background: var(--bm-bg);
      color: var(--bm-fg);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      border-radius: 8px;
      overflow: hidden;
      box-sizing: border-box;
    }
    .bm-embed * { box-sizing: border-box; }
    .bm-status {
      padding: 6px 10px;
      font-size: 11px;
      opacity: 0.75;
      border-bottom: 1px solid color-mix(in srgb, var(--bm-fg) 15%, transparent);
      flex-shrink: 0;
    }
    .bm-log {
      flex: 1;
      overflow-y: auto;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .bm-entry { max-width: 90%; padding: 6px 10px; border-radius: 8px; line-height: 1.4; white-space: pre-wrap; }
    .bm-entry-user { align-self: flex-end; background: var(--bm-accent); color: #fff; }
    .bm-entry-agent { align-self: flex-start; background: color-mix(in srgb, var(--bm-fg) 12%, transparent); }
    .bm-entry-pending { align-self: flex-start; opacity: 0.6; font-style: italic; }
    .bm-entry-error { align-self: flex-start; background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .bm-chips { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
    .bm-chip {
      display: inline-block;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--bm-accent) 30%, transparent);
    }
    .bm-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid color-mix(in srgb, var(--bm-fg) 15%, transparent); flex-shrink: 0; }
    .bm-input {
      flex: 1;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--bm-fg) 25%, transparent);
      background: transparent;
      color: var(--bm-fg);
    }
    .bm-input:disabled, .bm-submit:disabled { opacity: 0.5; }
    .bm-submit {
      padding: 6px 14px;
      border-radius: 6px;
      border: none;
      background: var(--bm-accent);
      color: #fff;
      cursor: pointer;
    }
  `
}

/**
 * Build the widget skeleton inside `root` (a ShadowRoot or any node
 * supporting appendChild) and return references to the live pieces callers
 * need to wire up and update.
 *
 * @param {Document} doc
 * @param {object} root - ShadowRoot (or shadow-root-shaped stub)
 * @param {object} [config]
 * @param {object} [config.theme]
 * @returns {{ root: object, statusEl: object, logEl: object, formEl: object, inputEl: object, submitEl: object }}
 */
export function buildSkeleton(doc, root, config = {}) {
  const style = doc.createElement('style')
  style.textContent = buildCss(config.theme)

  const wrap = doc.createElement('div')
  wrap.classList.add('bm-embed')

  const statusEl = doc.createElement('div')
  statusEl.classList.add('bm-status')

  const logEl = doc.createElement('div')
  logEl.classList.add('bm-log')

  const formEl = doc.createElement('form')
  formEl.classList.add('bm-form')

  const inputEl = doc.createElement('input')
  inputEl.setAttribute('type', 'text')
  inputEl.setAttribute('placeholder', 'Message…')
  inputEl.classList.add('bm-input')

  const submitEl = doc.createElement('button')
  submitEl.setAttribute('type', 'submit')
  submitEl.classList.add('bm-submit')
  submitEl.textContent = 'Send'

  formEl.appendChild(inputEl)
  formEl.appendChild(submitEl)

  wrap.appendChild(statusEl)
  wrap.appendChild(logEl)
  wrap.appendChild(formEl)

  root.appendChild(style)
  root.appendChild(wrap)

  return { root: wrap, statusEl, logEl, formEl, inputEl, submitEl }
}

/**
 * Update the status line from current pod state.
 * @param {object} statusEl
 * @param {{ state?: string, role?: string, peerCount?: number }} info
 */
export function setStatus(statusEl, { state, role, peerCount = 0 } = {}) {
  if (!statusEl) return
  const parts = []
  if (state) parts.push(state)
  if (role) parts.push(role)
  parts.push(`${peerCount} peer${peerCount === 1 ? '' : 's'}`)
  statusEl.textContent = parts.join(' · ')
}

/**
 * Append a message-log entry.
 * @param {Document} doc
 * @param {object} logEl
 * @param {{ role: 'user'|'agent'|'pending'|'error', content?: string, toolCalls?: Array, error?: boolean }} entry
 * @returns {object|null} the created entry element
 */
export function appendEntry(doc, logEl, { role = 'agent', content = '', toolCalls, error } = {}) {
  if (!logEl) return null
  const variant = error ? 'error' : role
  const el = doc.createElement('div')
  el.classList.add('bm-entry', `bm-entry-${variant}`)
  el.textContent = content

  if (Array.isArray(toolCalls) && toolCalls.length) {
    const chips = doc.createElement('div')
    chips.classList.add('bm-chips')
    for (const call of toolCalls) {
      const chip = doc.createElement('span')
      chip.classList.add('bm-chip')
      chip.textContent = call?.name || 'tool'
      chips.appendChild(chip)
    }
    el.appendChild(chips)
  }

  logEl.appendChild(el)
  return el
}

/**
 * Enable/disable the input and submit controls (used for the "thinking…"
 * state between a submitted message and its response).
 * @param {object} inputEl
 * @param {object} submitEl
 * @param {boolean} disabled
 */
export function setInputDisabled(inputEl, submitEl, disabled) {
  if (inputEl) {
    inputEl.disabled = disabled
    inputEl.setAttribute?.('placeholder', disabled ? 'Thinking…' : 'Message…')
  }
  if (submitEl) submitEl.disabled = disabled
}
