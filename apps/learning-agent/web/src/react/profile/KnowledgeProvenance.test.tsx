// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { KnowledgeProvenance } from "./KnowledgeProvenance.js";

/**
 * E4.9i-P2-6 (T08 A/B) — how provenance is rendered.
 *
 * The pure rules are tested in `knowledge-provenance.test.ts`; these cases check
 * that the component shows *both* fields when both apply, that the evidence
 * count is never silently turned into 0, and that the two caveat lines are
 * present only where the caller asks for them.
 */

const renderProvenance = (props: Parameters<typeof KnowledgeProvenance>[0]) =>
	render(<KnowledgeProvenance {...props} />);

beforeEach(async () => {
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("KnowledgeProvenance — source label", () => {
	it("shows the derived label", () => {
		renderProvenance({ origin: "derived", evidenceIds: ["e1"] });
		expect(screen.getByText("系统推导")).toBeTruthy();
	});

	it("shows the manual label", () => {
		renderProvenance({ origin: "manual", evidenceIds: ["e1"] });
		expect(screen.getByText("人工维护")).toBeTruthy();
	});

	it("shows the legacy label", () => {
		renderProvenance({ origin: "legacy", evidenceIds: ["e1"] });
		expect(screen.getByText("历史记录")).toBeTruthy();
	});

	it("shows 来源未标明 when origin is missing", () => {
		renderProvenance({ evidenceIds: ["e1"] });
		expect(screen.getByText("来源未标明")).toBeTruthy();
	});

	it("shows 来源未标明 for an unknown origin, never 系统推导", () => {
		renderProvenance({ origin: "imported", evidenceIds: ["e1"] });
		expect(screen.getByText("来源未标明")).toBeTruthy();
		expect(screen.queryByText("系统推导")).toBeNull();
	});
});

describe("KnowledgeProvenance — the unknown-source hint", () => {
	it("is absent when provenance_unknown is false", () => {
		renderProvenance({ origin: "derived", provenance_unknown: false, evidenceIds: ["e1"] });
		expect(screen.queryByText("来源不明")).toBeNull();
	});

	it("is absent when provenance_unknown is missing", () => {
		renderProvenance({ origin: "derived", evidenceIds: ["e1"] });
		expect(screen.queryByText("来源不明")).toBeNull();
	});

	it("appears alongside the origin when provenance_unknown is true", () => {
		// Both fields must be readable at once: 「人工维护」 alone would hide that
		// the server could not trace the evidence.
		renderProvenance({ origin: "manual", provenance_unknown: true, evidenceIds: [] });
		expect(screen.getByText("人工维护")).toBeTruthy();
		expect(screen.getByText("来源不明")).toBeTruthy();
		expect(screen.getByText(/服务端未能追溯/)).toBeTruthy();
	});

	it("shows the hint for a legacy record too", () => {
		renderProvenance({ origin: "legacy", provenance_unknown: true, evidenceIds: [] });
		expect(screen.getByText("历史记录")).toBeTruthy();
		expect(screen.getByText("来源不明")).toBeTruthy();
	});

	it("shows a contradictory pair without correcting it", () => {
		renderProvenance({ origin: "derived", provenance_unknown: true, evidenceIds: ["e1"] });
		expect(screen.getByText("系统推导")).toBeTruthy();
		expect(screen.getByText("来源不明")).toBeTruthy();
	});
});

describe("KnowledgeProvenance — evidence count", () => {
	it("shows 0 for an empty array", () => {
		renderProvenance({ origin: "derived", evidenceIds: [] });
		expect(screen.getByText("证据标识 0 个")).toBeTruthy();
	});

	it("shows the count for one and many", () => {
		const { unmount } = renderProvenance({ origin: "derived", evidenceIds: ["e1"] });
		expect(screen.getByText("证据标识 1 个")).toBeTruthy();
		unmount();
		renderProvenance({ origin: "derived", evidenceIds: ["e1", "e2", "e3"] });
		expect(screen.getByText("证据标识 3 个")).toBeTruthy();
	});

	it("shows the phrase once, without a duplicate field label", () => {
		// 「证据标识 证据标识 3 个」 is what a label plus a complete phrase produces.
		renderProvenance({ origin: "derived", evidenceIds: ["e1", "e2", "e3"] });
		const rows = [...document.querySelectorAll(".mla-provenance__row")];
		const evidenceRow = rows[1];
		expect(evidenceRow.textContent?.trim()).toBe("证据标识 3 个");
		expect(evidenceRow.querySelectorAll(".mla-provenance__label")).toHaveLength(0);
	});

	it("counts a legacy mirror and its source separately", () => {
		renderProvenance({ origin: "legacy", evidenceIds: ["legacy_1", "event_1"] });
		expect(screen.getByText("证据标识 2 个")).toBeTruthy();
	});

	it("counts duplicates as stored", () => {
		renderProvenance({ origin: "legacy", evidenceIds: ["e1", "e1"] });
		expect(screen.getByText("证据标识 2 个")).toBeTruthy();
	});

	it("says unavailable, never 0, when the field cannot be read", () => {
		for (const value of [undefined, null, "e1", 3]) {
			const { unmount } = renderProvenance({ origin: "derived", evidenceIds: value });
			expect(screen.getByText("证据标识数量不可用"), String(value)).toBeTruthy();
			expect(screen.queryByText("证据标识 0 个"), String(value)).toBeNull();
			unmount();
		}
	});

	it("never renders an evidence-detail list", () => {
		// There is no detail API; the component must not imply one exists.
		const { container } = renderProvenance({ origin: "derived", evidenceIds: ["legacy_1"] });
		expect(container.querySelector("ul")).toBeNull();
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).not.toContain("legacy_1");
	});
});

describe("KnowledgeProvenance — notes", () => {
	it("omits the caveat lines by default", () => {
		renderProvenance({ origin: "derived", evidenceIds: ["e1"] });
		expect(screen.queryByText(/不代表证据质量/)).toBeNull();
		expect(screen.queryByText(/不等于独立学习或练习次数/)).toBeNull();
	});

	it("shows both caveat lines with withNotes", () => {
		renderProvenance({ origin: "derived", evidenceIds: ["e1"], withNotes: true });
		expect(screen.getByText(/不代表证据质量或可信度认证/)).toBeTruthy();
		expect(screen.getByText(/不等于独立学习或练习次数/)).toBeTruthy();
	});
});

describe("KnowledgeProvenance — English copy", () => {
	it("renders the English labels and count", async () => {
		await act(async () => { await i18n.changeLanguage("en"); });
		renderProvenance({ origin: "manual", provenance_unknown: true, evidenceIds: ["e1", "e2"] });
		expect(screen.getByText("Manually maintained")).toBeTruthy();
		expect(screen.getByText("Source unknown")).toBeTruthy();
		expect(screen.getByText("2 evidence identifiers")).toBeTruthy();
		expect(screen.queryByText("人工维护")).toBeNull();
	});
});
