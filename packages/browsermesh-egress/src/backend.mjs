/**
 * backend.mjs -- a netway `Backend` over an egress link, so a `VirtualNetwork` can route `tcp://` through a provider.
 *
 *   const net = new VirtualNetwork()
 *   net.addBackend('tcp', link.asBackend())
 *   const socket = await net.connect('tcp://registry.example:443')
 *
 * Only what the provider can do: connect and resolve (A records). Listening and datagrams are not offered (the base class
 * says so). Closing the backend leaves the link open: the link is the caller's.
 */
import { Backend, ConnectionRefusedError } from '@johnhenry/browsermesh-netway'
import { EGRESS_CONSUMER } from './wire.mjs'
import { EgressError } from './errors.mjs'

export class EgressBackend extends Backend {
  #link

  /** @param {{ connect: Function, lookup: Function }} link from `connectEgress` */
  constructor(link) {
    super()
    if (typeof link?.connect !== 'function' || typeof link?.lookup !== 'function') throw new TypeError('EgressBackend: a link from connectEgress is required')
    this.#link = link
    this[EGRESS_CONSUMER] = true
    this.connect[EGRESS_CONSUMER] = true
  }

  /** The link behind this backend. */
  get link() { return this.#link }

  /**
   * @param {string} host
   * @param {number} port
   * @returns {Promise<import('@johnhenry/browsermesh-netway').StreamSocket>}
   * @throws {ConnectionRefusedError} the destination refused the connection (`.cause` is the EgressError)
   * @throws {EgressError} anything else, with the provider's stable `code`
   */
  async connect(host, port) {
    try {
      return await this.#link.connect(host, port)
    } catch (e) {
      if (e instanceof EgressError && e.code === 'connect-failed' && e.detail === 'refused') throw Object.assign(new ConnectionRefusedError(`${host}:${port}`), { cause: e })
      throw e
    }
  }

  /**
   * @param {string} name
   * @param {string} [type='A']
   * @returns {Promise<string[]>} IPv4 addresses; rejects with `name-not-found` (`posix: 'ENOTFOUND'`) for a name that does not exist
   */
  async resolve(name, type = 'A') {
    if (type !== 'A') throw new EgressError('bad-request', 'Only the A record type is served.')
    return this.#link.lookup(name)
  }
}
