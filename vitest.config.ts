import { defineConfig } from "vitest/config";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// The preserved upstream full-mode smoke suite is replaced by server.learning/server.release tests.
export default defineConfig({
	// Isolated release checkouts may share the lockfile-matched dependency tree.
	// Allow its canonical path so worker ?url imports are also tested through junctions.
	server: { fs: { allow: [resolve("."), realpathSync("node_modules")] } },
	test: {
		exclude: ["**/node_modules/**", "runtime/**", "workspace/**", "apps/learning-agent/src/server.smoke.test.ts"],
		setupFiles: ["./vitest.setup.ts"],
		// Component tests (*.test.tsx) render real DOM; pure store/util tests
		// (*.test.ts) stay in the faster node environment.
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					include: ["apps/learning-agent/src/**/*.test.ts", "apps/learning-agent/web/src/**/*.test.ts", "electron/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				extends: true,
				test: {
					name: "web",
					include: ["apps/learning-agent/web/src/**/*.test.tsx"],
					environment: "jsdom",
				},
			},
		],
	},
});
