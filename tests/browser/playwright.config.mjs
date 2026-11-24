import { defineConfig, devices } from '@playwright/test'

// Chromium by default. BM_BROWSERS=firefox,webkit (comma separated) picks others;
// CI runs those as a separate, allowed-to-fail matrix leg.
const wanted = (process.env.BM_BROWSERS ?? 'chromium').split(',').map((s) => s.trim()).filter(Boolean)

const projects = {
  chromium: {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        // Keep host candidates as plain loopback addresses instead of mDNS
        // names, so the WebRTC tests need no multicast. No STUN is configured.
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
      },
    },
  },
  firefox: {
    name: 'firefox',
    use: {
      ...devices['Desktop Firefox'],
      launchOptions: {
        firefoxUserPrefs: {
          'media.peerconnection.ice.obfuscate_host_addresses': false,
          'media.peerconnection.ice.loopback': true,
        },
      },
    },
  },
  webkit: { name: 'webkit', use: { ...devices['Desktop Safari'] } },
}

for (const name of wanted) {
  if (!projects[name]) throw new Error(`BM_BROWSERS: unknown browser "${name}" (chromium, firefox, webkit)`)
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  // The tests share one relay per worker and bind real loopback sockets; one
  // worker keeps the real WebRTC handshakes off a loaded machine.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  projects: wanted.map((name) => projects[name]),
})
