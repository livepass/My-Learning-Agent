// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { KnowledgeProvenance, ProvenanceRegionNotes } from "./KnowledgeProvenance.js";

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
		// the record carries historical information with no confirmable source.
		renderProvenance({ origin: "manual", provenance_unknown: true, evidenceIds: [] });
		expect(screen.getByText("人工维护")).toBeTruthy();
		expect(screen.getByText("来源不明")).toBeTruthy();
		expect(screen.getByText(/来源无法确认的历史信息/)).toBeTruthy();
	});

	it("does not claim the server ran a trace or that the record is wrong", () => {
		// F03: the flag is a fact about the record's history, not a verdict on the
		// evidence behind it or on the accuracy of the knowledge assessment.
		renderProvenance({ origin: "legacy", provenance_unknown: true, evidenceIds: [] });
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("服务端未能追溯");
		expect(text).not.toContain("内容有误");
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

	it("says unavailable for an array with non-identifier elements", () => {
		// F04: a damaged array is not a count. Rendering 1 for `["evt_1", null]`
		// would hide the damage behind a confident number.
		for (const value of [[null], [123], [{}], ["evt_1", null], ["evt_1", 123], [""]]) {
			const { unmount } = renderProvenance({ origin: "derived", evidenceIds: value });
			expect(screen.getByText("证据标识数量不可用"), JSON.stringify(value)).toBeTruthy();
			expect(screen.queryByText("证据标识 1 个"), JSON.stringify(value)).toBeNull();
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

describe("ProvenanceRegionNotes — F02. one explanation per region", () => {
	it("renders both caveats, in the same words as the reading view", () => {
		render(<ProvenanceRegionNotes />);
		expect(screen.getByText(/不代表证据质量或可信度认证/)).toBeTruthy();
		expect(screen.getByText(/不等于独立学习或练习次数/)).toBeTruthy();
		expect(screen.getByText(/当前暂不提供证据明细/)).toBeTruthy();
	});

	it("renders each caveat exactly once", () => {
		render(<ProvenanceRegionNotes />);
		expect(screen.getAllByText(/不代表证据质量或可信度认证/)).toHaveLength(1);
		expect(screen.getAllByText(/不等于独立学习或练习次数/)).toHaveLength(1);
	});

	it("does not render an evidence identifier or a count", () => {
		// It explains the number; it must not become a second, unlabelled count.
		const { container } = render(<ProvenanceRegionNotes />);
		expect(container.querySelector("[data-evidence-count]")).toBeNull();
	});

	it("carries the English copy too", async () => {
		await act(async () => { await i18n.changeLanguage("en"); });
		render(<ProvenanceRegionNotes />);
		expect(screen.getByText(/not a measure of evidence quality/)).toBeTruthy();
		expect(screen.getByText(/Evidence details are not available yet/)).toBeTruthy();
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
