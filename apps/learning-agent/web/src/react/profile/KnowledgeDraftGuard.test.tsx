// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { KnowledgeList } from "./KnowledgeList.js";
import { KnowledgeDraftGuardProvider } from "./KnowledgeDraftGuard.js";
import type { KnowledgeState } from "../../types/learner.js";

/**
 * E4.9i-P2-2-R1 — every exit from a knowledge edit goes through one verdict.
 *
 * Before R1 three exits silently dropped the draft (row header, section
 * collapse, course switch) and a late save re-opened a collapsed row. These
 * cases pin the replacement rule: unchanged leaves freely, dirty asks exactly
 * once, saving refuses outright.
 */

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "诊断文本",
	next_actions: ["下一步动作"],
	...patch,
});

const withGuard = (ui: React.ReactElement) => render(<KnowledgeDraftGuardProvider>{ui}</KnowledgeDraftGuardProvider>);
const rowHeader = (name: string) => screen.getByText(name).closest("button")!;

beforeEach(async () => { await act(async () => { await i18n.changeLanguage("zh-CN"); }); });
afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("R1 — knowledge row exits", () => {
	it("G01 collapses an unchanged editor without asking", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));

		fireEvent.click(rowHeader("c1"));

		expect(confirm).not.toHaveBeenCalled();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(rowHeader("c1").getAttribute("aria-expanded")).toBe("false");
	});

	it("G02 asks once when collapsing a dirty editor", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "改过的诊断" } });

		fireEvent.click(rowHeader("c1"));

		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G03 keeps the draft and the editor when the discard is refused", () => {
		vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "改过的诊断" } });

		fireEvent.click(rowHeader("c1"));

		expect(screen.getByDisplayValue("改过的诊断")).toBeTruthy();
		expect(rowHeader("c1").getAttribute("aria-expanded")).toBe("true");
	});

	it("G04 discarding collapses the row and shows the saved text again", () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "改过的诊断" } });
		fireEvent.click(rowHeader("c1"));
		expect(rowHeader("c1").getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(rowHeader("c1"));
		expect(screen.getByText("诊断文本")).toBeTruthy();
		expect(screen.queryByDisplayValue("改过的诊断")).toBeNull();
	});

	it("G05 does not ask when the draft was typed back to its saved value", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		const field = screen.getByDisplayValue("诊断文本");
		fireEvent.change(field, { target: { value: "改一下" } });
		fireEvent.change(field, { target: { value: "诊断文本" } });

		fireEvent.click(rowHeader("c1"));

		expect(confirm).not.toHaveBeenCalled();
		expect(rowHeader("c1").getAttribute("aria-expanded")).toBe("false");
	});

	it("G06 protects a changed next-action list", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("下一步动作"), { target: { value: "新的下一步" } });

		fireEvent.click(rowHeader("c1"));
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G07 protects a changed mastery slider", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByRole("slider"), { target: { value: "80" } });

		fireEvent.click(rowHeader("c1"));
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G10 asks once for the whole action even with several dirty rows", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[
			knowledge({ concept_id: "alpha" }),
			knowledge({ concept_id: "beta" }),
		]} onSave={vi.fn()} />);

		for (const name of ["alpha", "beta"]) {
			fireEvent.click(rowHeader(name));
			const row = rowHeader(name).parentElement!;
			fireEvent.click([...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === "编辑")!);
			fireEvent.change([...row.querySelectorAll("textarea")][0]!, { target: { value: `${name} 草稿` } });
		}

		// Collapsing one row is one action → one confirm, never one per row.
		fireEvent.click(rowHeader("alpha"));
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G23 a server refresh does not overwrite the dirty draft", () => {
		const states = [knowledge({ concept_id: "c1", diagnosis: "旧诊断" })];
		const { rerender } = withGuard(<KnowledgeList states={states} onSave={vi.fn()} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("旧诊断"), { target: { value: "正在编辑的草稿" } });

		rerender(
			<KnowledgeDraftGuardProvider>
				<KnowledgeList states={[knowledge({ concept_id: "c1", diagnosis: "服务端新诊断" })]} onSave={vi.fn()} />
			</KnowledgeDraftGuardProvider>,
		);

		expect(screen.getByDisplayValue("正在编辑的草稿")).toBeTruthy();
	});
});

describe("R1 — saving", () => {
	it("G14 refuses to collapse while a save is in flight", async () => {
		let resolveSave: () => void = () => {};
		const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(onSave).toHaveBeenCalled());

		fireEvent.click(rowHeader("c1"));

		expect(rowHeader("c1").getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("slider")).toBeTruthy();

		await act(async () => { resolveSave(); });
	});

	it("G17 disables the inputs while saving", async () => {
		let resolveSave: () => void = () => {};
		const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(onSave).toHaveBeenCalled());

		expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
		for (const area of screen.getAllByRole("textbox") as HTMLTextAreaElement[]) {
			expect(area.disabled).toBe(true);
		}

		await act(async () => { resolveSave(); });
	});

	it("G18 returns to reading after a delayed successful save", async () => {
		let resolveSave: () => void = () => {};
		const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await act(async () => { resolveSave(); });
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
	});

	it("G19 keeps the draft when a delayed save fails", async () => {
		let rejectSave: (err: Error) => void = () => {};
		const onSave = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "保存失败的草稿" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await act(async () => { rejectSave(new Error("网络中断")); });

		expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
		expect(screen.getByDisplayValue("保存失败的草稿")).toBeTruthy();
		expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(false);
	});

	it("G20 does not submit twice when save is clicked repeatedly", async () => {
		let resolveSave: () => void = () => {};
		const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));

		const save = screen.getByRole("button", { name: "保存" });
		fireEvent.click(save);
		await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
		fireEvent.click(save);
		fireEvent.click(save);

		expect(onSave).toHaveBeenCalledTimes(1);
		await act(async () => { resolveSave(); });
	});

	it("G21 a late save on one row never touches another row", async () => {
		let resolveFirst: () => void = () => {};
		const onSave = vi.fn()
			.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
			.mockResolvedValue(undefined);
		withGuard(<KnowledgeList states={[
			knowledge({ concept_id: "alpha" }),
			knowledge({ concept_id: "beta" }),
		]} onSave={onSave} />);

		const alpha = rowHeader("alpha").parentElement!;
		fireEvent.click(rowHeader("alpha"));
		fireEvent.click([...alpha.querySelectorAll("button")].find((b) => b.textContent?.trim() === "编辑")!);
		fireEvent.click([...alpha.querySelectorAll("button")].find((b) => b.textContent?.trim() === "保存")!);

		// Beta is opened and edited while alpha's save is still pending.
		fireEvent.click(rowHeader("beta"));
		const beta = rowHeader("beta").parentElement!;
		expect(beta.textContent).toContain("诊断文本");
		expect(beta.querySelector("input[type=range]")).toBeNull();

		await act(async () => { resolveFirst(); });
		// Alpha settled; beta is untouched.
		expect(beta.querySelector("input[type=range]")).toBeNull();
		expect(rowHeader("beta").getAttribute("aria-expanded")).toBe("true");
	});
});

describe("R1 — guard verdict", () => {
	it("G24 shows the confirm in English after a language switch", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		withGuard(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		await act(async () => { await i18n.changeLanguage("en"); });

		fireEvent.click(rowHeader("c1"));
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "draft" } });
		fireEvent.click(rowHeader("c1"));

		expect(confirm).toHaveBeenCalledOnce();
		expect(confirm.mock.calls[0]![0]).toMatch(/Discard/);
	});
});
