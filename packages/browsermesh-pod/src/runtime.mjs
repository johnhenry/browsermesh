/**
 * Runtime entrypoints for BrowserMesh pods.
 *
 * These convenience functions provide the documented API surface
 * (installPodRuntime, createRuntime, createClient, createServer)
 * as thin wrappers over the existing Pod infrastructure.
 */
import { Pod } from './pod.mjs'

/**
 * Create and boot a Pod in the given context.
 *
 * @param {object} [opts]
 * @param {typeof globalThis} [opts.context] - Global object to install on (default: globalThis)
 * @param {import('browsermesh-primitives').PodIdentity} [opts.identity] - Pre-existing identity
 * @param {object} [opts.discovery] - Discovery options
 * @param {number} [opts.discoveryTimeout] - Discovery timeout in ms (default: 2000)
 * @param {number} [opts.handshakeTimeout] - Handshake timeout in ms (default: 2000)
 * @returns {Promise<Pod>}
 */
export async function installPodRuntime(opts = {}) {
  const {
    context = globalThis,
    identity,
    discoveryTimeout = 2000,
    handshakeTimeout = 2000,
    ...rest
  } = opts

  const pod = new Pod()
  await pod.boot({
    globalThis: context,
    identity,
    discoveryTimeout,
    handshakeTimeout,
    ...rest,
  })
  return pod
}

/**
 * Alias for installPodRuntime — creates and boots a Pod runtime.
 *
 * @param {object} [opts] - Same options as installPodRuntime
 * @returns {Promise<Pod>}
 */
export const createRuntime = installPodRuntime

/**
 * Create a lightweight client pod for messaging and discovery.
 * Boots with a short discovery timeout and no handshake.
 *
 * @param {object} [opts]
 * @param {typeof globalThis} [opts.context] - Global object
 * @param {import('browsermesh-primitives').PodIdentity} [opts.identity] - Pre-existing identity
 * @param {number} [opts.discoveryTimeout] - Discovery timeout in ms (default: 500)
 * @returns {Promise<Pod>}
 */
export async function createClient(opts = {}) {
  const {
    context = globalThis,
    identity,
    discoveryTimeout = 500,
    ...rest
  } = opts

  const pod = new Pod()
  await pod.boot({
    globalThis: context,
    identity,
    discoveryTimeout,
    handshakeTimeout: 100,
    ...rest,
  })
  return pod
}

/**
 * Create a server-oriented pod that listens for connections.
 * Same as installPodRuntime but signals intent as a service provider.
 *
 * @param {object} [opts]
 * @param {typeof globalThis} [opts.context] - Global object
 * @param {import('browsermesh-primitives').PodIdentity} [opts.identity] - Pre-existing identity
 * @param {number} [opts.discoveryTimeout] - Discovery timeout in ms (default: 2000)
 * @returns {Promise<Pod>}
 */
export async function createServer(opts = {}) {
  const {
    context = globalThis,
    identity,
    discoveryTimeout = 2000,
    ...rest
  } = opts

  const pod = new Pod()
  await pod.boot({
    globalThis: context,
    identity,
    discoveryTimeout,
    handshakeTimeout: 2000,
    ...rest,
  })
  return pod
}
