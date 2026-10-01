// vite.config.ts — isolate-pod-host spike (issue #185 WP2)
//
// Hand-written (cf migrate does not generate this file). The spike has no
// front-end assets and no TypeScript build step of its own — this file only
// wires `@cloudflare/vite-plugin` so `cf build` / `cf dev` bundle
// src/worker.mjs through Vite directly, rather than falling back to the
// legacy esbuild-based bundler path. `experimental.newConfig: true` tells
// the plugin to read Worker config from `cloudflare.config.ts` instead of
// an old-style config file, which no longer exists in this spike (see
// README.md's "cf migration history" note for the full history).
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
	plugins: [
		cloudflare({
			experimental: { newConfig: true },
		}),
	],
});
