import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { ProviderIcon } from "./AddProviderWizard.js";

afterEach(cleanup);

describe("provider icon", () => {
	it("renders the brand asset on a transparent tile for a known provider", () => {
		const { container } = render(<ProviderIcon providerId="deepseek" />);
		expect(container.querySelector("img")?.getAttribute("src")).toBe("/provider-icons/deepseek.png");
		expect(container.textContent).toBe("");
	});

	// The Docker image once shipped without web/public, so every asset request
	// fell through to the SPA index.html and rendered as a broken image inside
	// a transparent tile. A missing brand asset must degrade to the glyph tile.
	it("falls back to the colored glyph tile when the brand asset fails to load", () => {
		const { container } = render(<ProviderIcon providerId="deepseek" />);
		fireEvent.error(container.querySelector("img")!);

		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toBe("DS");
		const tile = container.firstElementChild as HTMLElement;
		expect(tile.style.backgroundColor).toBe("rgb(77, 107, 254)");
	});

	it("uses the provider initial for an unknown provider", () => {
		const { container } = render(<ProviderIcon providerId="acme" />);
		expect(container.querySelector("img")).toBeNull();
		expect(screen.getByText("A")).toBeTruthy();
	});
});
