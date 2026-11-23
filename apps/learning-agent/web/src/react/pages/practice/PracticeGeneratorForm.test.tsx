// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/index.js";
import { PracticeGeneratorForm, type PracticeGeneratorFormProps } from "./PracticeGeneratorForm.js";

/**
 * E4.9h-P2-1 — the generation form is display only: it reports choices and
 * never calls the store. These cases pin the value round-trip and the disabled
 * rules the page relies on.
 */

function form(overrides: Partial<PracticeGeneratorFormProps> = {}) {
	const props: PracticeGeneratorFormProps = {
		conceptInputId: "practice-concept",
		concept: "",
		kind: "",
		goalId: "",
		allowModelFallback: true,
		concepts: [
			{ concept_id: "c1", concept_name: "闭包与作用域" },
			{ concept_id: "c2", concept_name: "装饰器的求值顺序" },
		],
		goals: [{ goal_id: "g1", title: "掌握 Python 函数式特性" }],
		generating: false,
		generateError: null,
		canGenerate: true,
		conceptIsUsable: true,
		conceptIsSynthetic: false,
		continuation: false,
		actionLabel: "生成练习题",
		onConceptChange: vi.fn(),
		onKindChange: vi.fn(),
		onGoalChange: vi.fn(),
		onAllowFallbackChange: vi.fn(),
		onGenerate: vi.fn(),
		...overrides,
	};
	render(<PracticeGeneratorForm {...props} />);
	return props;
}

/**
 * Open the optional-configuration disclosure.
 *
 * jsdom renders `<details>` content regardless of `open`, so the assertions
 * about fields below the fold are made after an explicit open — the same
 * state a learner reaches. Collapsed behaviour is asserted separately.
 */
function openAdvanced() {
	fireEvent.click(screen.getByText("更多出题选项"));
}

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("PracticeGeneratorForm — values", () => {
	it("T01 reports every choice to the page", () => {
		const props = form();

		fireEvent.change(screen.getByLabelText("知识点"), { target: { value: "闭包" } });
		expect(props.onConceptChange).toHaveBeenCalledWith("闭包");

		openAdvanced();
		fireEvent.change(screen.getByLabelText("题型"), { target: { value: "transfer" } });
		expect(props.onKindChange).toHaveBeenCalledWith("transfer");

		fireEvent.change(screen.getByLabelText("关联学习目标（可选）"), { target: { value: "g1" } });
		expect(props.onGoalChange).toHaveBeenCalledWith("g1");

		fireEvent.click(screen.getByRole("checkbox"));
		expect(props.onAllowFallbackChange).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByRole("button", { name: /生成练习题/ }));
		expect(props.onGenerate).toHaveBeenCalledTimes(1);
	});

	it("offers the profile concepts as datalist options", () => {
		form();

		const values = [...document.querySelectorAll("datalist#practice-concept-options option")]
			.map((option) => option.getAttribute("value"));
		expect(values).toEqual(["闭包与作用域", "装饰器的求值顺序"]);
	});

	it("hides the goal field when the learner has no goals", () => {
		form({ goals: [] });

		expect(screen.queryByLabelText("关联学习目标（可选）")).toBeNull();
	});
});

describe("PracticeGeneratorForm — disabled rules", () => {
	it("T02 disables the inputs and the action while generating", () => {
		// The page folds `!isGenerating` into `canGenerate`, so generating also
		// means the action is not allowed.
		form({ generating: true, canGenerate: false });

		expect((screen.getByLabelText("知识点") as HTMLInputElement).disabled).toBe(true);
		openAdvanced();
		expect((document.getElementById("practice-concept-kind") as HTMLSelectElement).disabled).toBe(true);
		const action = screen.getByRole("button", { name: /正在生成/ }) as HTMLButtonElement;
		expect(action.disabled).toBe(true);
		expect(screen.queryByRole("button", { name: /生成练习题/ })).toBeNull();
	});

	it("keeps the action disabled when the page says generation is not allowed", () => {
		form({ canGenerate: false });

		expect((screen.getByRole("button", { name: /生成练习题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("keeps the action disabled while the concept is unusable", () => {
		form({ conceptIsUsable: false });

		expect((screen.getByRole("button", { name: /生成练习题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("warns that a synthetic id cannot be used as a concept name", () => {
		form({ concept: "concept_45125622e640", conceptIsSynthetic: true, conceptIsUsable: false });

		expect(screen.getByText(/这是系统生成的标识/)).toBeTruthy();
	});
});

describe("PracticeGeneratorForm — errors and modes", () => {
	it("T03 shows the server's failure message verbatim", () => {
		form({ generateError: "没有找到可用于出题的知识来源，也没有允许使用模型知识。" });

		expect(screen.getByRole("alert").textContent)
			.toBe("没有找到可用于出题的知识来源，也没有允许使用模型知识。");
	});

	it("switches its hint between the first question and a continuation", () => {
		form();
		const first = document.body.textContent;

		cleanup();
		form({ continuation: true, actionLabel: "生成下一题" });

		expect(document.body.textContent).not.toBe(first);
		expect(screen.getByRole("button", { name: /生成下一题/ })).toBeTruthy();
	});

	it("only shows the cancel action when the page provides one", () => {
		form();
		expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();

		cleanup();
		const onCancel = vi.fn();
		form({ onCancel });
		fireEvent.click(screen.getByRole("button", { name: /取消/ }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("T15 renders in English", async () => {
		form();
		await i18n.changeLanguage("en");

		expect(screen.getByLabelText("Concept")).toBeTruthy();
		// The advanced disclosure is open (jsdom does not hide its content), so
		// the English label is checked alongside its summary.
		expect(screen.getByText("More question options")).toBeTruthy();
		expect(screen.getByLabelText("Question type")).toBeTruthy();
	});
});

/**
 * E4.9h-P2-4 — the optional configuration is folded, and folding never
 * touches a value.
 *
 * The disclosure is a native `<details>`: the browser owns open/closed, so
 * these cases check the summary text, that the fields keep their values across
 * a close/re-open cycle, and that the page still receives every change.
 */
describe("PracticeGeneratorForm — advanced options", () => {
	const advanced = () => document.querySelector("details.mla-generator-advanced") as HTMLDetailsElement | null;

	it("T11 keeps the concept input and the action visible", () => {
		form();

		expect(screen.getByLabelText("知识点")).toBeTruthy();
		expect(screen.getByRole("button", { name: /生成练习题/ })).toBeTruthy();
	});

	it("T12 starts with the advanced options collapsed", () => {
		form();

		const details = advanced();
		expect(details).toBeTruthy();
		expect(details!.open).toBe(false);
		expect(screen.getByText("更多出题选项")).toBeTruthy();
	});

	it("T13 reveals goal, kind and fallback when opened", () => {
		form();
		openAdvanced();

		expect(screen.getByLabelText("关联学习目标（可选）")).toBeTruthy();
		expect(screen.getByLabelText("题型")).toBeTruthy();
		expect(screen.getByRole("checkbox")).toBeTruthy();
	});

	it("T14 keeps every chosen value across a collapse and re-open", () => {
		const props = form({ concept: "Python 闭包", goalId: "g1", kind: "transfer", allowModelFallback: false });
		const details = advanced()!;

		openAdvanced();
		expect((screen.getByLabelText("关联学习目标（可选）") as HTMLSelectElement).value).toBe("g1");
		expect((screen.getByLabelText("题型") as HTMLSelectElement).value).toBe("transfer");
		expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);

		fireEvent.click(screen.getByText("更多出题选项"));
		expect(details.open).toBe(false);
		fireEvent.click(screen.getByText("更多出题选项"));

		// The values live in the page, so hiding the fields never resets them.
		expect((screen.getByLabelText("关联学习目标（可选）") as HTMLSelectElement).value).toBe("g1");
		expect((screen.getByLabelText("题型") as HTMLSelectElement).value).toBe("transfer");
		expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
		expect(props.onKindChange).not.toHaveBeenCalled();
		expect(props.onGoalChange).not.toHaveBeenCalled();
		expect(props.onAllowFallbackChange).not.toHaveBeenCalled();
	});

	it("T15 does not render an empty goal select when the profile has none", () => {
		form({ goals: [] });
		openAdvanced();

		expect(screen.queryByLabelText("关联学习目标（可选）")).toBeNull();
		// The other two advanced fields are still there.
		expect(screen.getByLabelText("题型")).toBeTruthy();
	});

	it("T16 keeps the action disabled while generating, even when collapsed", () => {
		form({ generating: true, canGenerate: false });

		const details = advanced()!;
		expect(details.open).toBe(false);
		expect((screen.getByRole("button", { name: /正在生成/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("T17 keeps the failure message outside the disclosure", () => {
		form({ generateError: "没有找到可用于出题的知识来源，也没有允许使用模型知识。" });

		// The error is a sibling of the disclosure, so collapsing never hides it.
		const alert = screen.getByRole("alert");
		expect(alert.closest("details")).toBeNull();
		expect(alert.textContent).toContain("没有找到可用于出题的知识来源");
	});

	it("T18 keeps blocking a synthetic concept while the options are collapsed", () => {
		form({ concept: "concept_45125622e640", conceptIsSynthetic: true, conceptIsUsable: false });

		expect(screen.getByText(/这是系统生成的标识/)).toBeTruthy();
		expect((screen.getByRole("button", { name: /生成练习题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("keeps the disclosure a native control that keyboard users can operate", () => {
		form();

		const details = advanced()!;
		const summary = details.querySelector("summary")!;
		// No click handler is attached: the browser toggles `open` itself, which
		// is what makes Enter/Space work without extra key handling.
		expect(summary.textContent).toBe("更多出题选项");
		expect(summary.getAttribute("tabindex")).toBeNull();
		fireEvent.click(summary);
		expect(details.open).toBe(true);
	});
});
