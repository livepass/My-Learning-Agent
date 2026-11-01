import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const monoRoot = resolve(__dirname, "../..");
const webSrc = resolve(__dirname, "../inno-agent/web/src");

// The plugins below mirror apps/learning-agent/web/vite.config.ts — they exist to
// make @earendil-works/pi-web-ui (pulled in by MarkdownArtifact) bundle
// correctly. Keep them in sync with the main app's config.

// pi-web-ui depends on @lmstudio/sdk for model discovery,
// but inno-agent does not use LM Studio — stub it out to avoid bundling.
const stubLmStudioPlugin = {
	name: "stub-lmstudio-sdk",
	enforce: "pre" as const,
	resolveId(id: string) {
		if (id === "@lmstudio/sdk") return "\0stub:@lmstudio/sdk";
	},
	load(id: string) {
		if (id === "\0stub:@lmstudio/sdk") return "export const LMStudioClient = class {};";
	},
};

// See the main app's vite.config.ts for the rationale: mini-lit's
// MarkdownBlock re-registers marked extensions on every render; route through
// a once-per-page-load guard as a source transform.
const MINILIT_MARKED_GUARD = "__innoRegisterMarkedExtensionsOnce";
const patchMiniLitMarkedPlugin = {
	name: "inno-patch-minilit-marked",
	enforce: "pre" as const,
	transform(code: string, id: string) {
		const path = id.split("?", 1)[0];
		if (!path.includes("@mariozechner/mini-lit") || !path.endsWith("MarkdownBlock.js")) return null;
		if (code.includes(MINILIT_MARKED_GUARD)) return null;
		if (code.split("marked.use({").length !== 2) {
			console.warn("[inno-patch-minilit-marked] unexpected marked.use() count in MarkdownBlock.js — leaving upstream code untouched");
			return null;
		}
		const prelude = `function ${MINILIT_MARKED_GUARD}(markedInstance, options) {\n\tif (globalThis.__innoMarkedExtensionsDone) return;\n\tglobalThis.__innoMarkedExtensionsDone = true;\n\tmarkedInstance.use(options);\n}\n`;
		return {
			code: prelude + code.replace("marked.use({", `${MINILIT_MARKED_GUARD}(marked, {`),
			map: null,
		};
	},
};

export default defineConfig({
	// Relative base so the site works under any sub-path (GitHub Pages project
	// sites, S3 prefixes, etc.).
	base: "./",
	optimizeDeps: {
		// The main app's vite config discovers pi-web-ui statically (it lives
		// inside that app's root), so highlight.js etc. get prebundled with
		// CJS→ESM interop. Here pi-web-ui is only reached through the @inno-web
		// source alias at runtime, which the dep scanner doesn't follow — raw
		// mini-lit then imports raw highlight.js/lib (CJS) and crashes with
		// "does not provide an export named 'default'". Force-prebundle it.
		// mini-lit is served raw (excluded below, so the marked patch transform
		// applies), and its CodeBlock.js deep-imports these CJS subpaths — they
		// must each be prebundled with interop or dev mode crashes with
		// "does not provide an export named 'default'".
		include: [
			"@earendil-works/pi-web-ui",
			"highlight.js",
			"highlight.js/lib/core",
			"highlight.js/lib/languages/bash",
			"highlight.js/lib/languages/css",
			"highlight.js/lib/languages/javascript",
			"highlight.js/lib/languages/json",
			"highlight.js/lib/languages/python",
			"highlight.js/lib/languages/sql",
			"highlight.js/lib/languages/typescript",
			"highlight.js/lib/languages/xml",
		],
		exclude: ["@mariozechner/mini-lit"],
	},
	resolve: {
		alias: {
			// Import the main app's rendering components straight from source so
			// the showcase always reflects the current frontend at build time.
			"@inno-web": webSrc,
		},
	},
	plugins: [
		stubLmStudioPlugin,
		patchMiniLitMarkedPlugin,
		react(),
		{
			name: "link-katex-fonts",
			buildStart() {
				// pi-web-ui's built CSS references url(fonts/KaTeX_...) relative to
				// its dist/; the fonts live in node_modules/katex/dist/fonts/.
				const source = resolve(monoRoot, "node_modules/katex/dist/fonts");
				const target = resolve(monoRoot, "node_modules/@earendil-works/pi-web-ui/dist/fonts");
				if (!existsSync(target)) {
					try {
						symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
						cpSync(source, target, { recursive: true });
					}
				}
			},
		},
		tailwindcss(),
	],
	server: {
		port: 5174,
	},
	build: {
		rollupOptions: {
			output: {
				onlyExplicitManualChunks: true,
				manualChunks(id) {
					if (!id.includes("node_modules")) return undefined;
					if (
						id.includes("/node_modules/react/") ||
						id.includes("/node_modules/react-dom/") ||
						id.includes("/node_modules/scheduler/")
					) {
						return "react-vendor";
					}
					if (id.includes("/node_modules/@earendil-works/pi-web-ui/")) {
						return "pi-web-ui";
					}
					if (id.includes("/node_modules/katex/")) {
						return "katex";
					}
					return undefined;
				},
			},
		},
	},
});
