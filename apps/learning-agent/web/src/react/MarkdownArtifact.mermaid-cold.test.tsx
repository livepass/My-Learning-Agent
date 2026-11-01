// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { getMermaidMarkdownRuntime } from "../utils/mermaid-runtime.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string, vars?: Record<string, unknown>) => {
			const template = fallback ?? _key;
			if (!vars) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(vars[name] ?? match));
		},
	}),
}));

afterEach(cleanup);

// A separate isolated file leaves the application runtime cache unprepared.
// Exercise the actual lazy chunks here, including the loading shell, instead
// of charging their observed 9s+ preparation cost to a 5s menu interaction.
it("loads the real Mermaid runtime from its cold placeholder and preserves the complete response", async () => {
	expect(getMermaidMarkdownRuntime()).toBeNull();
	const source = "图示如下：\n\n```mermaid\nflowchart LR\nA[开始] --> B[完成]\n```\n\n图示结束。";
	const { container, getByRole } = render(<MarkdownArtifact content={source} />);
	expect(container.querySelector(".inno-mermaid-suspense-placeholder")).not.toBeNull();

	await waitFor(() => {
		expect(getMermaidMarkdownRuntime()).not.toBeNull();
		expect(container.querySelector(".inno-mermaid-suspense-placeholder")).toBeNull();
		expect(container.querySelector("[data-inno-mermaid-preview]")).not.toBeNull();
		expect(getByRole("radio", { name: "图表" })).not.toBeNull();
		expect(getByRole("button", { name: "复制代码" })).not.toBeNull();
		expect(getByRole("button", { name: "更多" })).not.toBeNull();
		expect(container.textContent).toContain("图示如下");
		expect(container.textContent).toContain("图示结束");
	}, { timeout: 55_000 });
}, 60_000);
