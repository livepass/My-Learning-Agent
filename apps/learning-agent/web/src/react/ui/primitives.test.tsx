// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BookOpen } from "lucide-react";
import { Badge, Card, EmptyState, Field, StatusBadge, Input } from "./index.js";

/**
 * E4.9c — shared learning primitives.
 *
 * These components exist to remove hand-written duplicates from the learning
 * pages, so the tests pin the parts a page relies on: the tone classes, the
 * variant class, the accessible association of a field label with its control,
 * and that none of them depend on a store or hard-code copy.
 */

afterEach(() => cleanup());

describe("Badge", () => {
	it("renders a neutral badge by default and a tone class when asked", () => {
		render(
			<>
				<Badge>plain</Badge>
				<Badge tone="accent">current</Badge>
				<StatusBadge tone="danger">failed</StatusBadge>
			</>,
		);
		expect(screen.getByText("plain").className).toBe("mla-badge");
		expect(screen.getByText("current").className).toContain("mla-badge--accent");
		expect(screen.getByText("failed").className).toContain("mla-badge--danger");
	});

	it("passes through arbitrary attributes so pages keep their aria semantics", () => {
		render(<Badge tone="warning" aria-label="到期复习">到期</Badge>);
		expect(screen.getByLabelText("到期复习").textContent).toBe("到期");
	});
});

describe("Card", () => {
	it("uses the variant class and the requested element", () => {
		const { container } = render(
			<>
				<Card>default</Card>
				<Card variant="practice" as="article">practice</Card>
				<Card variant="group" as="div">group</Card>
				<Card variant="selectable">selectable</Card>
			</>,
		);
		const [plain, practice, group, selectable] = Array.from(container.children) as HTMLElement[];
		expect(plain.tagName).toBe("SECTION");
		expect(plain.className).toBe("mla-card");
		expect(practice.tagName).toBe("ARTICLE");
		expect(practice.className).toBe("mla-practice-card");
		expect(group.tagName).toBe("DIV");
		expect(group.className).toBe("mla-archive-group");
		expect(selectable.className).toBe("mla-course-pick");
	});
});

describe("EmptyState", () => {
	it("renders title, description and action, and is announced as status", () => {
		render(
			<EmptyState
				icon={BookOpen}
				title="No courses yet"
				description="Create a course first."
				action={<button type="button">Create</button>}
			/>,
		);
		const region = screen.getByRole("status");
		expect(region.textContent).toContain("No courses yet");
		expect(region.textContent).toContain("Create a course first.");
		expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
	});

	it("uses a compact layout without changing the text", () => {
		const { container } = render(<EmptyState compact title="Empty" />);
		expect((container.firstElementChild as HTMLElement).className).toContain("mla-empty--compact");
		expect(screen.getByText("Empty")).toBeTruthy();
	});
});

describe("Field", () => {
	it("associates the label with the control and links the hint", () => {
		render(
			<Field label="Course title" hint="Shown on the course card">
				{(props) => <Input {...props} />}
			</Field>,
		);
		const input = screen.getByLabelText("Course title") as HTMLInputElement;
		const describedBy = input.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy!)?.textContent).toBe("Shown on the course card");
		expect(input.getAttribute("aria-invalid")).toBeNull();
	});

	it("replaces the hint with an error and marks the control invalid", () => {
		render(
			<Field label="Title" hint="ignored when there is an error" error="Title is required">
				{(props) => <Input {...props} />}
			</Field>,
		);
		const input = screen.getByLabelText("Title");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByRole("alert").textContent).toBe("Title is required");
		expect(screen.queryByText("ignored when there is an error")).toBeNull();
	});

	it("honours a caller-supplied id so a page can query the control", () => {
		render(
			<Field label="Plan title" id="plan-title">
				{(props) => <Input {...props} />}
			</Field>,
		);
		expect((screen.getByLabelText("Plan title") as HTMLInputElement).id).toBe("plan-title");
	});
});
