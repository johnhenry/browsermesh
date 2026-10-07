/**
 * worker.mjs — Worker entry for the isolate-pod-host spike (issue #185 WP2,
 * extended by the hosted-pods control surface work).
 *
 * Two lines of real content: re-export the `PodObject` Durable Object
 * class so the runtime can find it, and hand every request to
 * `handlePodHostRequest()`. The route table itself lives in `routes.mjs`
 * so it can be tested in Node without `cf dev` — see that file's
 * module doc comment for why the split exists and for the full route list.
 */

import { handlePodHostRequest } from './routes.mjs'

export { PodObject } from './pod-object.mjs'

export default {
  /**
   * @param {Request} request
   * @param {{ POD: DurableObjectNamespace, RELAY_URL: string, SIGNALING_URL: string, DISCOVERY_CHANNEL: string }} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    return handlePodHostRequest(request, env)
  },
}
