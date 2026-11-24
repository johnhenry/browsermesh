/**
 * Whether the isolated-vm suite may be skipped.
 *
 * `isolated-vm` is an optional native dependency, so on a machine without a
 * binary the suite is skipped, and a skipped suite reports success. CI sets
 * `REQUIRE_ISOLATED_VM=1` so that a missing addon fails instead: the suite is
 * then never skipped, and the first test of it reports the reason.
 *
 * @param {{available: boolean, reason?: string}} availability result of `isolatedVmAvailability()`
 * @param {Record<string, string|undefined>} [env]
 * @returns {{skip: false|string, required: boolean}}
 */
export function isolatedVmSuiteOptions(availability, env = process.env) {
  const required = env.REQUIRE_ISOLATED_VM === '1'
  if (availability.available || required) return { skip: false, required }
  return { skip: `isolated-vm is not available here: ${availability.reason}`, required }
}
