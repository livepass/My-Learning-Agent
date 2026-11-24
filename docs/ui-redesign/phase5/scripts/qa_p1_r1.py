#!/usr/bin/env python3
"""E4.9i-P1-R1 browser check for the standalone, in-repo prototype.

Run from a local checkout:
    python3 -m pip install playwright
    python3 -m playwright install chromium
    python3 docs/ui-redesign/phase5/scripts/qa_p1_r1.py

Unlike opening GitHub's source viewer, this executes the actual HTML prototype
in Chromium. The page uses synthetic fixture data; no production API is called.
"""
from __future__ import annotations

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

PHASE = Path(__file__).resolve().parents[1]
SOURCE = PHASE / "prototype-a.html"
ASSETS = PHASE / "assets"
METRICS = ASSETS / "r1-browser-metrics.json"


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def capture(page, filename: str, *, expected_width: int):
    # The prototype's device frame has explicit 320px width on mobile.
    obj = page.evaluate("""() => {
      const vp = document.querySelector('.viewport');
      const shell = vp.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.krow-main')];
      const filters = [...document.querySelectorAll('.fchip')];
      return {
        outerWidth: window.innerWidth,
        frameWidth: shell.width,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        visibleRows: rows.length,
        filterNames: filters.map(x => x.textContent.trim()),
        pressed: filters.filter(x => x.getAttribute('aria-pressed') === 'true').map(x => x.dataset.key),
        stateCountCaption: [...document.querySelectorAll('.stat .k')].map(x => x.textContent.trim()),
      };
    }""")
    ensure(not obj["overflow"], filename + ": horizontal document overflow")
    ensure(obj["outerWidth"] == expected_width, filename + ": viewport mismatch")
    ensure(len(obj["filterNames"]) == 6, filename + ": missing six filter chips")
    ensure("待复习状态" in obj["stateCountCaption"], filename + ": ambiguous due counter")
    page.screenshot(path=str(ASSETS / filename), full_page=True)
    obj["file"] = filename
    return obj


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    html = SOURCE.read_text(encoding="utf-8")
    measurements = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height, filename in [
                (1440, 900, "r1-option-a-desktop.png"),
                (320, 640, "r1-option-a-320.png"),
            ]:
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                # set_content allows testing this standalone HTML without an HTTP server.
                page.set_content(html, wait_until="load")
                ensure(page.locator("#viewport").count() == 1, "missing unique device frame id")
                ensure(page.locator("#viewport-control").count() == 1, "missing unique viewport selector")
                ensure(page.locator(".fchip").count() == 6, "missing state filter")
                ensure(page.locator(".fchip[aria-pressed='true']").count() == 1, "multiple active filters")
                if width == 320:
                    page.select_option("#viewport-control", "320")
                    ensure("vp-320" in page.locator("#viewport").get_attribute("class"), "viewport switch failed")
                else:
                    page.select_option("#viewport-control", "desktop")
                page.locator("#app").wait_for(state="visible")
                measurements[str(width)] = capture(page, filename, expected_width=width)
                ensure(not errors, "script errors: " + repr(errors))

                # Click: filtered review_due items are a subset of the original set.
                before = page.locator(".krow-main").count()
                chip = page.locator('.fchip[data-key="review_due"]')
                chip.click()
                filtered = page.locator(".krow-main").count()
                ensure(0 < filtered < before, "filter did not reduce knowledge rows")
                ensure(chip.get_attribute("aria-pressed") == "true", "filter not marked pressed")
                ensure(page.locator(".fchip[aria-pressed='true']").count() == 1, "multiple selected chips")
                ensure(not page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"), "filtered layout overflows")
                measurements[str(width)]["reviewDueRows"] = filtered
                measurements[str(width)]["allRows"] = before
                if width == 320:
                    page.screenshot(path=str(ASSETS / "r1-option-a-320-filtered.png"), full_page=True)

                # Keyboard: Space selects 'all' again, Enter selects 'stable'.
                all_chip = page.locator('.fchip[data-key="all"]')
                all_chip.focus()
                page.keyboard.press("Space")
                ensure(all_chip.get_attribute("aria-pressed") == "true", "Space key did not activate all")
                stable = page.locator('.fchip[data-key="stable"]')
                stable.focus()
                page.keyboard.press("Enter")
                ensure(stable.get_attribute("aria-pressed") == "true", "Enter key did not activate stable")

                # Use a fixture with no stable knowledge to verify empty-filter feedback.
                page.select_option("#scenario", "review-due")
                ensure(page.locator('.fchip[data-key="all"]').get_attribute("aria-pressed") == "true",
                       "scenario switch did not reset filter")
                page.locator('.fchip[data-key="stable"]').click()
                ensure(page.get_by_text("当前筛选下没有知识点，可选择其他状态。").count() == 1,
                       "empty filter feedback missing")

                # Existing draft must survive a cancelled filter change.
                page.select_option("#scenario", "all-records")
                page.locator(".krow-main").first.click()
                page.locator('[data-act="concept-edit"]').first.click()
                diagnosis = page.locator('[data-act="draft-diagnosis"]')
                ensure(diagnosis.count() == 1, "concept edit mode did not open")
                diagnosis.fill("R1 uncommitted edit must survive")
                page.once("dialog", lambda dialog: dialog.dismiss())
                page.locator('.fchip[data-key="review_due"]').click()
                ensure(page.locator('[data-act="draft-diagnosis"]').input_value() ==
                       "R1 uncommitted edit must survive", "draft lost on cancelled filter")
                ensure(page.locator('.fchip[data-key="all"]').get_attribute("aria-pressed") == "true",
                       "filter changed after cancelled confirm")
                page.once("dialog", lambda dialog: dialog.accept())
                page.locator('.fchip[data-key="review_due"]').click()
                ensure(page.locator('[data-act="draft-diagnosis"]').count() == 0,
                       "confirmed filter did not leave edit mode")
                measurements[str(width)]["keyboardAndEditConfirm"] = "PASS"
                ensure(not errors, "script errors after interactions: " + repr(errors))
                page.close()
        finally:
            browser.close()
    METRICS.write_text(json.dumps({
        "source": str(SOURCE.relative_to(PHASE)),
        "runtime": "Playwright Chromium, standalone fixture HTML, no live API",
        "verdict": "PASS",
        "measurements": measurements,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("R1 PASS — see", METRICS)


if __name__ == "__main__":
    main()
