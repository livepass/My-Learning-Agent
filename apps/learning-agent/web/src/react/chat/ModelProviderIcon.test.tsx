import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelProviderIcon } from "./ModelProviderIcon.js";

afterEach(cleanup);

describe("model provider icon", () => {
	it("renders the brand asset for a known provider", () => {
		const { container } = render(<ModelProviderIcon provider="kimi" />);
		expect(container.querySelector("img")?.getAttribute("src")).toBe("/provider-icons/kimi-rounded.png");
	});

	it("falls back to the generic mark when the brand asset fails to load", () => {
		const { container } = render(<ModelProviderIcon provider="kimi" />);
		fireEvent.error(container.querySelector("img")!);

		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("svg")).not.toBeNull();
	});
});
