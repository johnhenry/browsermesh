/**
 * The kernel is capability-secure: a tenant can only use what it was
 * granted, and that's enforced by throwing, not by convention.
 *
 * browsermesh-kernel's `createTenant({ capabilities })` returns a frozen
 * `caps` object; `requireCap(caps, tag)` is what every kernel-mediated
 * operation checks before proceeding. This example creates two tenants
 * with deliberately different grants and shows the SAME operation
 * (checking for clock access) succeeding for one and throwing
 * `CapabilityDeniedError` for the other — the security boundary is real,
 * not just documented.
 */

import assert from 'node:assert/strict'
import { Kernel, KERNEL_CAP, requireCap, CapabilityDeniedError } from '@johnhenry/browsermesh-kernel'

const kernel = new Kernel()

const trusted = kernel.createTenant({ capabilities: [KERNEL_CAP.CLOCK, KERNEL_CAP.RNG] })
const restricted = kernel.createTenant({ capabilities: [KERNEL_CAP.RNG] }) // no CLOCK

console.log('kernel tenants:', kernel.listTenants())
assert.equal(kernel.tenantCount, 2)

// The trusted tenant was granted CLOCK — requireCap is a no-op.
requireCap(trusted.caps, KERNEL_CAP.CLOCK)
console.log('trusted tenant:   requireCap(CLOCK) passed ✓')

// The restricted tenant was NOT granted CLOCK — requireCap throws.
assert.throws(
  () => requireCap(restricted.caps, KERNEL_CAP.CLOCK),
  CapabilityDeniedError,
)
console.log('restricted tenant: requireCap(CLOCK) threw CapabilityDeniedError ✓')

// Both tenants share the RNG grant.
requireCap(trusted.caps, KERNEL_CAP.RNG)
requireCap(restricted.caps, KERNEL_CAP.RNG)
console.log('both tenants:      requireCap(RNG) passed ✓')

// The kernel's own clock is real and shared — uptime advances.
const before = kernel.uptime
await new Promise((r) => setTimeout(r, 20))
const after = kernel.uptime
assert.ok(after > before, `expected uptime to advance (${before} -> ${after})`)
console.log(`kernel uptime advanced: ${before}ms -> ${after}ms`)

kernel.destroyTenant(restricted.id)
assert.equal(kernel.tenantCount, 1)
console.log('destroyTenant() drops it from tenantCount ✓')

kernel.close()

console.log('ok: capability grants are enforced per-tenant, not just declared')
