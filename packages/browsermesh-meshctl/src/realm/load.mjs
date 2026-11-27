import { UsageError } from '../output.mjs'

/**
 * Load `@johnhenry/browsermesh-realm`, an OPTIONAL peer (a separate package, so installing meshctl does not pull it in), so every
 * command other than `realm ...` works without it. A missing package is a usage error that says what to install.
 */
export async function loadRealmPackage() {
  try {
    return await import('@johnhenry/browsermesh-realm')
  } catch (cause) {
    if (cause?.code === 'ERR_MODULE_NOT_FOUND' && /@johnhenry\/browsermesh-realm\b/.test(String(cause.message))) {
      throw new UsageError('the realm commands need @johnhenry/browsermesh-realm: npm install @johnhenry/browsermesh-realm')
    }
    throw cause
  }
}
