/**
 * actions.mjs -- which action of the registry an object operation needs.
 *
 * Every operation of wsh's object layer is judged by its OWN action, as a
 * scope `objects:<root>:<action>` through the registry (`createRootAuthorizer`):
 *
 *   get, describe, snapshot  ->  get
 *   call, construct          ->  call   (a call that carries callbacks is still one call:
 *                                        the callbacks are arguments of it)
 *   set                      ->  set
 *   on (a subscription)      ->  on
 *
 * An operation through a handle is judged by the layer as the producing path
 * extended by the member, with the kind of the operation that is performed
 * through it, so a handle never turns a `get` into a `call`: a peer granted
 * `objects:app:get` can read through a handle and cannot call through it.
 *
 * Anything this table does not name is NOT allowed. There is no fallback to
 * `get`: an operation a newer layer adds is refused until it is named here.
 */

/** The actions of the object layer, in the order of the scopes a grant lists. */
export const OBJECT_ACTIONS = Object.freeze(['get', 'call', 'set', 'on'])

const ACTION_OF_KIND = new Map([
  ['get', 'get'],
  ['describe', 'get'],
  ['snapshot', 'get'],
  ['call', 'call'],
  ['construct', 'call'],
  ['set', 'set'],
  ['on', 'on'],
])

/**
 * @param {{ kind?: string }} op - an operation as the layer hands it to `authorize`
 * @returns {'get'|'call'|'set'|'on'|null} null when the kind is not one this adapter knows (and so is refused)
 */
export function actionFor(op) {
  const kind = op?.kind
  return typeof kind === 'string' ? ACTION_OF_KIND.get(kind) ?? null : null
}
