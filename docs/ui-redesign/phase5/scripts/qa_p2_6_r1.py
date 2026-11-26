"""E4.9i-P2-6-R1 isolated Playwright acceptance, run after starting Vite on 5193.

Uses only page.route fixture responses, NOT a real backend. Run the real HTTP
route test in server.smoke.test.ts separately for manual.priority assertions.
Never writes original P2-6 assets. Outputs are created only on actual execution.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PHASE = HERE.parent
ASSETS = PHASE / "P2-6-assets"
SCRIPT = HERE / "qa_p2_6.py"
spec = importlib.util.spec_from_file_location("p26_original", SCRIPT)
assert spec is not None and spec.loader is not None
p26 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p26)
# Rebind only the module in this process: the original script and evidence stay unchanged.
p26.ASSETS = ASSETS
METRICS = ASSETS / "r1-browser-metrics.json"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def capture(page, errors, scenario, width, lang="zh-CN", course=False):
    data = p26.measure_course(page) if course else p26.measure(page)
    require(data is not None, f"{scenario}: no page geometry")
    data.update({"scenario": scenario, "viewport": f"{width}x640",
                 "language": lang, "pageErrors": list(errors), "apiMode": "simulated"})
    require(not data["document"]["overflowsHorizontally"],
            f"{scenario}: horizontal page overflow")
    require(not errors, f"{scenario}: pageErrors={errors!r}")
    out = ASSETS / f"r1-{scenario.lower()}.png"
    page.screenshot(path=str(out), full_page=True)
    data["screenshot"] = out.name
    return data


def goal_edit(browser, scenario, value, *, new_title=None, choice=None, cancel=False,
              update_during_edit=None, fail=False):
    fixture = p26.profile([], goals=[p26.goal("g_r1", "R1 Goal", value)])
    fixture["goals"][0]["manual"] = {"priority": {"at_seq": 5, "edit": 9}}
    page, errors, holder, requests = p26.open_page(
        browser, width=390, height=640, profile_payload=fixture)
    initial = copy.deepcopy(holder["profile"]["goals"][0])
    section = p26.goal_section(page)
    card = section.locator("div.rounded-xl", has_text="R1 Goal").first
    handle = card.element_handle()
    card.get_by_role("button", name="编辑").click()
    if update_during_edit is not None:
        holder["profile"]["goals"][0]["priority"] = update_during_edit
        holder["profile"]["goals"][0]["manual"]["priority"]["edit"] = 10
    if new_title is not None:
        handle.query_selector("input:not([type=range])").fill(new_title)
    if choice == 0:
        handle.query_selector("button:has-text('设为 0%')").click()
    elif choice == 1:
        handle.query_selector("button:has-text('设为 100%')").click()
    elif choice is not None:
        handle.query_selector("input[type=range]").fill(str(int(choice * 100)))
    if fail:
        def failing(route, request):
            if request.method == "PATCH" and "/api/learner/profile/goals/g_r1" in request.url:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "simulated failure"}))
            return route.fallback()
        page.route(p26.API_ROUTE, failing)
    if cancel:
        handle.query_selector("button:has-text('取消')").click()
    else:
        handle.query_selector("button:has-text('保存')").click()
    page.wait_for_timeout(450)
    writes = p26.requests_to(requests, "/api/learner/profile/goals/g_r1")
    if cancel:
        require(not writes, f"{scenario}: cancel sent PATCH")
    else:
        require(len(writes) == 1, f"{scenario}: expected one PATCH, got {len(writes)}")
        body = writes[0]["body"]
        require(("priority" in body) == (choice is not None),
                f"{scenario}: priority field presence mismatch: {body}")
        if choice is not None:
            require(body["priority"] == choice, f"{scenario}: wrong priority {body}")
    server_record = copy.deepcopy(holder["profile"]["goals"][0])
    require(server_record["priority"] == (
        value if update_during_edit is None or fail or cancel else update_during_edit)
        if choice is None else server_record["priority"] == (value if fail or cancel else choice),
        f"{scenario}: stored priority mismatch")
    if update_during_edit is not None and not cancel:
        require(server_record["priority"] == update_during_edit,
                f"{scenario}: server value was overwritten")
    if fail:
        require(handle.query_selector("input:not([type=range])") is not None,
                f"{scenario}: failed save discarded draft")
    data = capture(page, errors, scenario, 390)
    data.update({"beforeServerRecord": initial, "changedFields": [
        x for x in ["title", "priority"] if (x == "title" and new_title is not None) or
        (x == "priority" and choice is not None)],
        "patchRequests": writes, "prioritySubmitted": bool(writes and
        "priority" in (writes[-1].get("body") or {})),
        "serverReturnedRecord": None if fail or cancel else server_record,
        "storedRecordAfter": server_record,
        "manualPriorityBefore": initial["manual"]["priority"],
        "manualPriorityAfter": server_record["manual"]["priority"],
        "manualStampEvidence": "simulated fixture only; see real HTTP smoke test"})
    page.close()
    return data


def course_note(browser, scenario, lang):
    fixture = p26.PROFILE_EN if lang == "en" else p26.PROFILE_ZH
    page, errors, holder, requests = p26.open_page(
        browser, width=320, height=640, profile_payload=fixture, lang=lang)
    selector = "Select profile scope" if lang == "en" else "选择学习档案范围"
    # Trigger localized scope selector by its Radix data role if label differs.
    trigger = page.get_by_label(selector)
    if trigger.count() == 0:
        trigger = page.locator("button[role=combobox]").first
    trigger.focus()
    page.keyboard.press("Enter")
    target = "同义替换"
    page.get_by_role("option", name=target).click()
    page.wait_for_timeout(400)
    note = page.locator("section", has=page.locator("[data-course-evidence-note]"))
    require(note.count() >= 1, f"{scenario}: selected-course caveat not visible")
    lines = page.locator("[data-course-evidence-note]")
    require(lines.count() == 1, f"{scenario}: caveat repeated {lines.count()} times")
    text = lines.first.inner_text()
    expect = ("Evidence details are not available yet." if lang == "en"
              else "当前暂不提供证据明细")
    require(expect in text, f"{scenario}: caveat missing {text!r}")
    data = capture(page, errors, scenario, 320, lang=lang, course=True)
    data["caveat"] = text
    data["caveatCount"] = lines.count()
    page.close()
    return data


def malformed_evidence(browser):
    fixture = p26.profile([
        p26.state("bad", "Malformed evidence", origin="legacy",
                  evidence=["evt_1", None], provenance_unknown=True)])
    page, errors, holder, requests = p26.open_page(
        browser, width=320, height=640, profile_payload=fixture)
    row = p26.open_row(page, "Malformed evidence")
    require("证据标识数量不可用" in row.inner_text(),
            "R08: mixed evidence array must be unavailable")
    data = capture(page, errors, "R08", 320)
    data["evidenceIds"] = ["evt_1", None]
    page.close()
    return data


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    out = []
    with sync_playwright() as browser_driver:
        browser = browser_driver.chromium.launch()
        try:
            # The original B01–B10 test script is never changed; B03 and B09
            # use corrected R1 assertions because their old expected copy and
            # title-only PATCH semantics were defective.
            for fn in (p26.b01_1440_all_courses, p26.b02_390_stacked,
                       p26.b04_320_english, p26.b05_dark, p26.b06_manual_save_success,
                       p26.b07_save_failure, p26.b08_legacy_mirror, p26.b10_course_320):
                fn(browser, out)
            page, errors, _, _ = p26.open_page(
                browser, width=320, height=640, profile_payload=p26.PROFILE_ZH)
            p26.open_row(page, "连接词逻辑")
            require("来源无法确认的历史信息" in page.locator("body").inner_text(),
                    "B03-R1: new source-unknown copy absent")
            out.append(capture(page, errors, "B03-R1", 320))
            page.close()
            out.append(goal_edit(browser, "B09-R1", 3, new_title="Title only"))
            out.append(goal_edit(browser, "R01", 3, new_title="Title only"))
            out.append(goal_edit(browser, "R02", 0.5, new_title="Status-only surrogate"))
            for suffix, v in enumerate((0, 0.4, 1)):
                out.append(goal_edit(browser, f"R03-{suffix}", 3, choice=v))
            out.append(goal_edit(browser, "R04", 0.5, new_title="Updated title",
                                 update_during_edit=0.85))
            out.append(goal_edit(browser, "R05-cancel", 3, cancel=True))
            out.append(goal_edit(browser, "R05-failure", 3, new_title="Failed", fail=True))
            out.append(course_note(browser, "R06", "zh-CN"))
            out.append(course_note(browser, "R07", "en"))
            out.append(malformed_evidence(browser))
        finally:
            browser.close()
    METRICS.write_text(json.dumps({
        "status": "executed", "runtime": "Chromium Playwright, simulated API via page.route",
        "realRouteCheck": "server.smoke.test.ts R1 F01 (separate, not simulated)",
        "originalP26EvidenceUntouched": True, "scenarios": out
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PASS: {len(out)} checks; wrote {METRICS}")


if __name__ == "__main__":
    main()
