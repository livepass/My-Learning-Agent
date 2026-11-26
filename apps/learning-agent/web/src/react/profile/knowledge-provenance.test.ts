// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import {
	describeEvidenceCount,
	describeProvenance,
	evidenceSummary,
	formatGoalPriority,
	goalPatchFromDraft,
	goalPriorityLine,
	goalPriorityText,
	priorityForSlider,
} from "./knowledge-provenance.js";

/**
 * E4.9i-P2-6 (T08 A / B / D) — the display rules for provenance, evidence
 * count and goal priority.
 *
 * These are pure functions, so the cases here are the *semantics*: what a value
 * means and what must never be claimed. The rendering that consumes them is
 * covered by `KnowledgeProvenance.test.tsx`, the profile suites, and the
 * browser measurements in `qa_p2_6.py`.
 */

const t = (key: string, options?: Record<string, unknown>) =>
	options ? `${key}:${JSON.stringify(options)}` : key;

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

describe("describeProvenance — A. origin semantics", () => {
	it("maps each known origin to its own label key", () => {
		expect(describeProvenance({ origin: "derived" }).labelKey).toBe("profile.knowledge.provenance.originDerived");
		expect(describeProvenance({ origin: "manual" }).labelKey).toBe("profile.knowledge.provenance.originManual");
		expect(describeProvenance({ origin: "legacy" }).labelKey).toBe("profile.knowledge.provenance.originLegacy");
		for (const origin of ["derived", "manual", "legacy"]) {
			expect(describeProvenance({ origin }).unspecified, origin).toBe(false);
		}
	});

	it("reports a missing origin as unspecified", () => {
		for (const state of [{}, { origin: undefined }, { origin: null }, { origin: "" }]) {
			const display = describeProvenance(state);
			expect(display.labelKey, JSON.stringify(state)).toBe("profile.knowledge.provenance.originUnspecified");
			expect(display.unspecified).toBe(true);
			expect(display.origin).toBeNull();
		}
	});

	it("never folds an unrecognised origin into derived", () => {
		// The specific failure this guards: a new server value silently shown as
		// 「系统推导」 would attribute the record to a source that did not make it.
		for (const origin of ["imported", "DERIVED", "system", "unknown", "derived ", "0"]) {
			const display = describeProvenance({ origin });
			expect(display.labelKey, origin).toBe("profile.knowledge.provenance.originUnspecified");
			expect(display.unspecified, origin).toBe(true);
			// The raw value is preserved for reporting, not rewritten.
			expect(display.origin, origin).toBe(origin);
		}
	});

	it("keeps origin and provenance_unknown independent", () => {
		const manualUnknown = describeProvenance({ origin: "manual", provenance_unknown: true });
		expect(manualUnknown.labelKey).toBe("profile.knowledge.provenance.originManual");
		expect(manualUnknown.provenanceUnknown).toBe(true);

		const manualKnown = describeProvenance({ origin: "manual", provenance_unknown: false });
		expect(manualKnown.provenanceUnknown).toBe(false);
	});

	it("treats only literal true as 'source unknown'", () => {
		// Absent or false means "the server did not flag it", not "verified".
		for (const value of [undefined, null, false]) {
			expect(describeProvenance({ origin: "derived", provenance_unknown: value }).provenanceUnknown,
				String(value)).toBe(false);
		}
		expect(describeProvenance({ origin: "derived", provenance_unknown: true }).provenanceUnknown).toBe(true);
	});

	it("does not treat a merely truthy value as the flag", () => {
		// The field is a boolean on the wire. `Boolean(value)` would light up the
		// 「来源不明」 badge for a serialised `1` or `"false"`, which is a claim about
		// the data that was never made.
		for (const value of [1, "true", "false", {}, []]) {
			expect(describeProvenance({ origin: "derived", provenance_unknown: value as never }).provenanceUnknown,
				JSON.stringify(value)).toBe(false);
		}
	});

	it("shows a contradictory pair as-is instead of correcting it", () => {
		// derived + unknown is a fact about the data; smoothing it over would hide
		// the very inconsistency the reader needs to see.
		const display = describeProvenance({ origin: "derived", provenance_unknown: true });
		expect(display.labelKey).toBe("profile.knowledge.provenance.originDerived");
		expect(display.provenanceUnknown).toBe(true);
	});

	it("ignores mastery, confidence and state_label entirely", () => {
		// The function's parameter type has no such fields; this asserts the
		// behaviour if a caller passes a whole KnowledgeState.
		const whole = {
			origin: undefined,
			provenance_unknown: undefined,
			mastery: 0.9,
			confidence: 0.95,
			state_label: "stable",
			evidence_ids: ["e1", "e2", "e3"],
		} as never;
		const display = describeProvenance(whole);
		expect(display.labelKey).toBe("profile.knowledge.provenance.originUnspecified");
		expect(display.provenanceUnknown).toBe(false);
	});
});

describe("describeProvenance — A. copy in both languages", () => {
	it("renders the Chinese labels", async () => {
		const text = (origin: string) => i18n.t(describeProvenance({ origin }).labelKey);
		expect(text("derived")).toBe("系统推导");
		expect(text("manual")).toBe("人工维护");
		expect(text("legacy")).toBe("历史记录");
		expect(i18n.t(describeProvenance({}).labelKey)).toBe("来源未标明");
	});

	it("renders the English labels", async () => {
		await i18n.changeLanguage("en");
		const text = (origin: string) => i18n.t(describeProvenance({ origin }).labelKey);
		expect(text("derived")).toBe("System-derived");
		expect(text("manual")).toBe("Manually maintained");
		expect(text("legacy")).toBe("Legacy record");
		expect(i18n.t(describeProvenance({}).labelKey)).toBe("Source unspecified");
	});

	it("has an 'unknown' badge and hint in both languages", async () => {
		expect(i18n.t("profile.knowledge.provenance.unknownBadge")).toBe("来源不明");
		await i18n.changeLanguage("en");
		expect(i18n.t("profile.knowledge.provenance.unknownBadge")).toBe("Source unknown");
	});

	it("describes the flag without claiming a trace was attempted or that the record is wrong", async () => {
		// F03: `provenance_unknown` is set when a legacy value was preserved with
		// no reproducible source (see `projection.ts` / `profile-updater.ts`). The
		// copy must not claim the server ran a trace operation, must not say every
		// linked evidence is unreliable, and must not judge the record's accuracy.
		const zh = i18n.t("profile.knowledge.provenance.unknownHint");
		expect(zh).toBe("此记录包含来源无法确认的历史信息，不能据此判断证据质量或知识判断的准确性。");
		expect(zh).not.toContain("服务端未能追溯");
		expect(zh).not.toContain("所有");
		expect(zh).not.toContain("有误");

		await i18n.changeLanguage("en");
		const en = i18n.t("profile.knowledge.provenance.unknownHint");
		expect(en).toBe(
			"This record contains historical information whose provenance cannot be confirmed. "
			+ "This flag does not establish evidence quality or the accuracy of the knowledge assessment.",
		);
		expect(en).not.toContain("could not trace");
	});
});

describe("describeEvidenceCount — B. evidence count semantics", () => {
	it("counts an empty array as 0", () => {
		expect(describeEvidenceCount([])).toEqual({ count: 0, available: true });
	});

	it("counts one and many identifiers", () => {
		expect(describeEvidenceCount(["e1"])).toEqual({ count: 1, available: true });
		expect(describeEvidenceCount(["e1", "e2", "e3"])).toEqual({ count: 3, available: true });
	});

	it("does not deduplicate, so a legacy mirror and its source both count", () => {
		// The stored array is the authority; tidying it here would silently change
		// every count already shown.
		expect(describeEvidenceCount(["legacy_1", "event_1"]).count).toBe(2);
		expect(describeEvidenceCount(["e1", "e1", "e1"]).count).toBe(3);
	});

	it("reports an unreadable value as unavailable, never 0", () => {
		for (const value of [undefined, null, "e1", 3, {}, { length: 2 },
			[null], [123], [{}], ["evt_1", null], ["evt_1", 123]]) {
			const result = describeEvidenceCount(value);
			expect(result.available, JSON.stringify(value)).toBe(false);
			expect(result.count, JSON.stringify(value)).toBeNull();
		}
	});

	it("reports an array with non-identifier elements as unavailable", () => {
		// F04: the server's writer only stores strings, so any of these means the
		// payload is damaged. Filtering the bad elements out would report a
		// smaller, confident count about data this build cannot read.
		const broken: unknown[] = [
			[null],
			[123],
			[{}],
			["evt_1", null],
			["evt_1", 123],
			[true],
			[["nested"]],
		];
		for (const value of broken) {
			const result = describeEvidenceCount(value);
			expect(result.available, JSON.stringify(value)).toBe(false);
			expect(result.count, JSON.stringify(value)).toBeNull();
		}
	});

	it("reports blank strings as unavailable", () => {
		// A blank id *can* be stored (`updateProfile()` merges knowledge_states
		// without normalising `evidence_ids`), so this is not a corruption check.
		// The server's own evidence counts skip blank ids
		// (`daily-plan.ts:133`, `recommendations.ts:97`), so showing one as
		// evidence would display a number the server does not use.
		for (const value of [[""], ["   "], ["evt_1", ""], ["evt_1", " \t "]]) {
			const result = describeEvidenceCount(value);
			expect(result.available, JSON.stringify(value)).toBe(false);
			expect(result.count, JSON.stringify(value)).toBeNull();
		}
	});

	it("counts a valid array as stored, whatever the identifier shape", () => {
		// No shape validation beyond "non-blank string": the count is about the
		// array, and legacy mirrors carry their own identifier formats.
		expect(describeEvidenceCount(["evt_1", "evd_2", "legacy_3_evt_1"]))
			.toEqual({ count: 3, available: true });
		expect(describeEvidenceCount(["evt_1", "evt_1"])).toEqual({ count: 2, available: true });
	});

	it("does not mutate the array it is given", () => {
		const ids = ["evt_1", "evt_1", "legacy_1"];
		const copy = [...ids];
		describeEvidenceCount(ids);
		expect(ids).toEqual(copy);
	});
});

describe("evidenceSummary — B. one-line wording", () => {
	it("uses the shared count wording", () => {
		expect(evidenceSummary(t, ["e1", "e2"])).toBe(
			'profile.knowledge.provenance.evidenceCount:{"count":2}',
		);
	});

	it("says unavailable rather than 0 when the field cannot be read", () => {
		expect(evidenceSummary(t, undefined)).toBe("profile.knowledge.provenance.evidenceUnavailable");
	});

	it("renders the real copy in both languages", async () => {
		expect(evidenceSummary(i18n.t.bind(i18n), ["a", "b"])).toBe("证据标识 2 个");
		expect(evidenceSummary(i18n.t.bind(i18n), [])).toBe("证据标识 0 个");
		await i18n.changeLanguage("en");
		expect(evidenceSummary(i18n.t.bind(i18n), ["a", "b"])).toBe("2 evidence identifiers");
	});
});

describe("formatGoalPriority — D. priority boundaries", () => {
	it("treats 0, 0.5 and 1 as normal percentages", () => {
		expect(formatGoalPriority(0)).toEqual({ kind: "percent", percent: 0, raw: 0 });
		expect(formatGoalPriority(0.5)).toEqual({ kind: "percent", percent: 50, raw: 0.5 });
		expect(formatGoalPriority(1)).toEqual({ kind: "percent", percent: 100, raw: 1 });
	});

	it("reports a negative value as an anomaly with its raw value", () => {
		expect(formatGoalPriority(-0.2)).toEqual({ kind: "anomaly", raw: -0.2 });
	});

	it("reports a value above 1 as an anomaly, not 300%", () => {
		// The specific failure this guards: `priority = 3` used to render as 300%.
		expect(formatGoalPriority(3)).toEqual({ kind: "anomaly", raw: 3 });
	});

	it("treats NaN, Infinity, missing and non-numeric as unavailable", () => {
		for (const value of [NaN, Infinity, -Infinity, undefined, null, "0.5", {}, []]) {
			expect(formatGoalPriority(value).kind, String(value)).toBe("unavailable");
		}
	});

	it("words each case through the shared copy", async () => {
		expect(goalPriorityText(i18n.t.bind(i18n), 0.5)).toBe("50%");
		expect(goalPriorityText(i18n.t.bind(i18n), 3)).toBe("优先级异常 · 原始值 3");
		expect(goalPriorityText(i18n.t.bind(i18n), NaN)).toBe("优先级不可用");
		await i18n.changeLanguage("en");
		expect(goalPriorityText(i18n.t.bind(i18n), 3)).toBe("Priority anomaly · raw value 3");
	});

	it("words the whole line without repeating the field name", async () => {
		// 「优先级 优先级异常 · 原始值 3」 is what a bare prefix plus a complete
		// anomaly sentence produces; only the percentage is a bare number.
		expect(goalPriorityLine(i18n.t.bind(i18n), 0.5)).toBe("优先级 50%");
		expect(goalPriorityLine(i18n.t.bind(i18n), 3)).toBe("优先级异常 · 原始值 3");
		expect(goalPriorityLine(i18n.t.bind(i18n), NaN)).toBe("优先级不可用");
		await i18n.changeLanguage("en");
		expect(goalPriorityLine(i18n.t.bind(i18n), 0.5)).toBe("Priority 50%");
		expect(goalPriorityLine(i18n.t.bind(i18n), 3)).toBe("Priority anomaly · raw value 3");
	});

	it("never renders an anomaly as a clamped percentage", async () => {
		for (const value of [1.5, 3, -1]) {
			const text = goalPriorityText(i18n.t.bind(i18n), value);
			expect(text, String(value)).not.toContain("%");
			expect(text, String(value)).toContain(String(value));
		}
	});
});

describe("goalPatchFromDraft — F01. only what the user changed is sent", () => {
	const stored = {
		title: "背完核心词表",
		type: "skill",
		status: "active",
		priority: 3,
		success_criteria: ["能默写 80%"],
	};

	it("sends nothing when the draft equals the stored goal", () => {
		expect(goalPatchFromDraft(stored, { ...stored }, false)).toEqual({});
	});

	it("sends only the title when only the title changed", () => {
		expect(goalPatchFromDraft(stored, { ...stored, title: "改过的标题" }, false))
			.toEqual({ title: "改过的标题" });
	});

	it("never sends priority for an untouched anomalous value", () => {
		// The whole point: `priority: 3` in the body would make the server stamp
		// it as human-owned, which is what F01 removes.
		const patch = goalPatchFromDraft(stored, { ...stored, status: "paused" }, false);
		expect(Object.keys(patch)).toEqual(["status"]);
	});

	it("sends priority when the user touched it, even at the same value", () => {
		// A touch is an explicit choice; the user may deliberately confirm a value
		// that happens to match. (For an anomaly the value can only match after the
		// endpoint button or a slider move, both of which set the flag.)
		expect(goalPatchFromDraft(stored, { ...stored, priority: 0.4 }, true))
			.toEqual({ priority: 0.4 });
	});

	it("accepts 0 and 1 as touched values", () => {
		expect(goalPatchFromDraft(stored, { ...stored, priority: 0 }, true).priority).toBe(0);
		expect(goalPatchFromDraft(stored, { ...stored, priority: 1 }, true).priority).toBe(1);
	});

	it("refuses to send a touched value outside [0,1]", () => {
		for (const value of [-0.2, 1.5, NaN, Infinity]) {
			const patch = goalPatchFromDraft(stored, { ...stored, priority: value }, true);
			expect(patch.priority, String(value)).toBeUndefined();
		}
	});

	it("compares success criteria by value, not by reference", () => {
		expect(goalPatchFromDraft(stored, { ...stored, success_criteria: ["能默写 80%"] }, false))
			.toEqual({});
		expect(goalPatchFromDraft(stored, { ...stored, success_criteria: ["能默写 80%", "能造句"] }, false))
			.toEqual({ success_criteria: ["能默写 80%", "能造句"] });
	});

	it("returns a copy of the criteria array", () => {
		const criteria = ["新标准"];
		const patch = goalPatchFromDraft(stored, { ...stored, success_criteria: criteria }, false);
		expect(patch.success_criteria).toEqual(criteria);
		expect(patch.success_criteria).not.toBe(criteria);
	});

	it("sends type only when it changed", () => {
		expect(goalPatchFromDraft(stored, { ...stored, type: "habit" }, false)).toEqual({ type: "habit" });
	});
});

describe("priorityForSlider — D. the slider must not rewrite the value", () => {
	it("keeps a normal value where it is", () => {
		expect(priorityForSlider(0)).toBe(0);
		expect(priorityForSlider(0.5)).toBe(0.5);
		expect(priorityForSlider(1)).toBe(1);
	});

	it("parks an anomaly at the nearest end without changing the stored value", () => {
		// Only the thumb position; `draft.priority` stays 3, so saving a title
		// change does not silently turn 3 into 1.
		expect(priorityForSlider(3)).toBe(1);
		expect(priorityForSlider(-1)).toBe(0);
		expect(formatGoalPriority(3).kind).toBe("anomaly");
	});

	it("falls back to 0 for an unusable value", () => {
		expect(priorityForSlider(NaN)).toBe(0);
		expect(priorityForSlider(undefined)).toBe(0);
	});
});

describe("R1 F04 — malformed arrays and string boundaries", () => {
	it("never counts arrays with any non-string element", () => {
		for (const ids of [[null], [123], [{}], ["evt_1", null], ["evt_1", 123]]) {
			expect(describeEvidenceCount(ids)).toEqual({ count: null, available: false });
			expect(evidenceSummary(i18n.t.bind(i18n), ids)).toBe("证据标识数量不可用");
		}
	});
	it("preserves the original length of string arrays", () => {
		// No dedupe, no filtering, whatever the identifier shape.
		for (const ids of [[], ["evt_1", "evt_1"], ["legacy_1", "evt_1"], ["evd_2"]]) {
			expect(describeEvidenceCount(ids)).toEqual({ count: ids.length, available: true });
		}
	});
	it("treats a blank identifier as unavailable, not as a countable string", () => {
		// The tool schema has no `minLength` and `updateProfile()` does not
		// normalise `evidence_ids`, so `""` can be stored — this is not a
		// corruption check. The server's own counts skip blank ids
		// (`daily-plan.ts:133`, `recommendations.ts:97`); counting one here would
		// show a number the server itself does not use.
		for (const ids of [[""], ["  "], ["evt_1", ""], ["evt_1", " \t "]]) {
			expect(describeEvidenceCount(ids)).toEqual({ count: null, available: false });
		}
	});
});
