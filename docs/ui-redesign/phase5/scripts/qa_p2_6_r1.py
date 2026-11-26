"""E4.9i-P2-6-R1 browser acceptance: goal-priority write scope, evidence wording.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_6_r1.py

Two groups of scenarios:

* **R01-R08** — the R1 fixes. F01: an untouched goal priority must not appear in
  the PATCH at all (the server stamps a field as human-owned from its *presence*,
  not its value), while a deliberate change — including the track endpoints —
  must be sendable. F02: the course knowledge regions explain the source and the
  identifier count once, above the list. F03: 「来源不明」 no longer claims a
  failed trace. F04: an evidence array with non-identifier elements reads as
  unavailable instead of a smaller, confident count.
* **B01-B10 rerun** — the original P2-6 scenarios, re-run from the same script so
  the two rounds are comparable, with B09's expectation corrected: a title-only
  save now sends no `priority` key, so the old assertion (`priority === 3`) is
  replaced by "the key is absent and the stored value is still 3".

The original `qa_p2_6.py` and everything under `P2-6-assets/` (its screenshots,
`p26-browser-metrics.json`, `p26-test-log.txt`) are **not modified**. R1 output
goes to `P2-6-assets/r1-browser-metrics.json` and `P2-6-assets/r1/`.

Every /api request is answered by `page.route` fixtures, so no real learner data
is read or written and no backend is needed. The goal PATCH fixture emulates the
server's ownership rule (`server/routes/learner.ts`): a field's stamp advances
only when the request body contains that field. That is what lets R01/R02/R04
prove the *request body*, not merely the rendered value — the browser half of the
contract whose server half is pinned by
`apps/learning-agent/src/server/routes/learner.goal-priority.test.ts`.

What a simulated API cannot prove is stated in the report: the mock is a
stand-in for the route, and the real route's stamp behaviour is proven by the
Vitest integration test, not here.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

# The P2-6 module holds the fixtures and probes; importing it runs nothing
# (`main()` is guarded), and re-running its scenarios here keeps one definition
# of each fixture instead of a drifting copy.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_p2_6 as p26  # noqa: E402

BASE = p26.BASE
API_ROUTE = p26.API_ROUTE
PHASE = p26.PHASE
ASSETS = PHASE / "P2-6-assets"
R1_DIR = ASSETS / "r1"
METRICS = ASSETS / "r1-browser-metrics.json"

TODAY = p26.TODAY
LONG_ZH = p26.LONG_ZH
LONG_EN = p26.LONG_EN
COURSE_LIST = p26.COURSE_LIST

ensure = p26.ensure
requests_to = p26.requests_to
row_by_name = p26.row_by_name
measure = p26.measure
measure_course = p26.measure_course
check_provenance = p26.check_provenance
show_provenance = p26.show_provenance
open_row = p26.open_row
expand_all_rows = p26.expand_all_rows
knowledge_section = p26.knowledge_section
goal_section = p26.goal_section


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def goal(goal_id, title, priority, *, status="active", manual_priority_edit=7):
    return {
        "goal_id": goal_id,
        "title": title,
        "type": "skill",
        "status": status,
        "priority": priority,
        "success_criteria": ["能读懂 90% 的段落"],
        # The ownership stamp the mock server tracks for `priority`. R01/R02/R04
        # compare it before and after a save: it must not move.
        "manual": {"priority": {"at_seq": 0, "edit": manual_priority_edit}},
    }


def profile(states, *, goals=None, summary="以 CET4 阅读为主线：先补同义替换。"):
    return {
        "learner_id": "default",
        "version": 7,
        "updated_at": TODAY,
        "goals": goals or [],
        "knowledge_states": states,
        "misconceptions": [],
        "preferences": {"explanation_style": [], "practice_style": [],
                        "feedback_tone": [], "avoid": []},
        "profile_summary": summary,
    }


def state(concept_id, name, label="learning", **extra):
    return p26.state(concept_id, name, label, **extra)


PROFILE_ZH = profile([
    state("k_derived", "同义替换", "learning", origin="derived",
          provenance_unknown=False, evidence=["e1", "e2"]),
    state("k_manual", "虚拟语气", "stable", origin="manual",
          provenance_unknown=False, evidence=[]),
    state("k_legacy", "连接词逻辑", "review_due", origin="legacy",
          provenance_unknown=True, evidence=["legacy_1", "event_1", "legacy_1"]),
    state("k_none", "长难句拆分", "unknown", evidence=["e9"]),
    state("k_imported", "近义词辨析", "fragile", origin="imported", evidence=["e7"]),
    state("k_unreadable", LONG_ZH, "misconception", origin="legacy",
          provenance_unknown=True, evidence=None),
], goals=[
    goal("g_normal", "读完 CET4 阅读真题", 0.5),
    goal("g_anomaly", "背完核心词表", 3),
])

PROFILE_EN = p26.PROFILE_EN

# R08: every shape the task book names, plus a blank string. Each must read
# 「证据标识数量不可用」 — never a filtered count.
PROFILE_BAD_EVIDENCE = profile([
    state("k_null_only", "空值元素", "learning", origin="derived", evidence=[None]),
    state("k_number_only", "数字元素", "learning", origin="derived", evidence=[123]),
    state("k_object_only", "对象元素", "learning", origin="derived", evidence=[{}]),
    state("k_mixed_null", "混合空值", "learning", origin="derived", evidence=["evt_1", None]),
    state("k_mixed_number", "混合数字", "learning", origin="derived", evidence=["evt_1", 123]),
    state("k_blank", "空白标识", "learning", origin="derived", evidence=[""]),
    state("k_good", "正常标识", "learning", origin="derived", evidence=["evt_1", "evt_2"]),
])

COURSE_A = {
    "course": {"course_id": "course_a", "title": "同义替换", "description": "",
               "status": "in_progress", "created_at": TODAY, "updated_at": TODAY},
    "goals": [],
    "knowledge_states": [
        state("k_derived", "同义替换", "learning", origin="derived",
              provenance_unknown=False, evidence=["e1"]),
        state("k_legacy", "连接词逻辑", "stable", origin="legacy",
              provenance_unknown=True, evidence=["legacy_1", "event_1"]),
        state("k_none", "长难句拆分", "unknown", evidence=["e9"]),
        state("k_unreadable", LONG_ZH, "misconception", origin="legacy",
              provenance_unknown=True, evidence=None),
    ],
    "preferences": {"explanation_style": [], "practice_style": [], "feedback_tone": [], "avoid": []},
    "unclassified": {"knowledge_states": 0, "goals": 0},
}

COURSE_A_EN = {
    **COURSE_A,
    "course": {**COURSE_A["course"], "title": "Synonyms"},
    "knowledge_states": [
        state("k_derived", "Substitute words", "learning", origin="derived",
              provenance_unknown=False, evidence=["e1"]),
        state("k_legacy", "Connector logic", "stable", origin="legacy",
              provenance_unknown=True, evidence=["legacy_1", "event_1"]),
    ],
}


# ---------------------------------------------------------------------------
# Page plumbing
# ---------------------------------------------------------------------------

def install_routes(page: Page, holder: dict):
    """Answer every API call from fixtures, emulating the goal PATCH rule.

    For `PATCH /api/learner/profile/goals/:id` the mock advances
    `manual.<field>.edit` **only for fields present in the body**, exactly as
    `server/routes/learner.ts` does. That is the observable R01/R02/R04 use:
    a title-only save must leave `manual.priority.edit` where it was.
    """
    requests: list[dict] = []
    holder.setdefault("requests", requests)
    holder.setdefault("knowledge_fail", False)
    holder.setdefault("goal_fail", False)

    def handler(route, request):
        path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
        body = None
        if request.post_data:
            try:
                body = json.loads(request.post_data)
            except json.JSONDecodeError:
                body = request.post_data
        requests.append({"method": request.method, "path": path, "body": body})

        if path == "/api/learner/profile" and request.method == "GET":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["profile"]))

        if path.startswith("/api/learner/profile/goals/"):
            goal_id = path.rsplit("/", 1)[-1]
            if holder["goal_fail"]:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "服务端暂时不可用"}))
            goals = holder["profile"]["goals"]
            stored = next((g for g in goals if g["goal_id"] == goal_id), None)
            if stored is None:
                return route.fulfill(status=404, content_type="application/json",
                                     body=json.dumps({"error": "Goal not found"}))
            manual = dict(stored.get("manual") or {})
            seq = holder.setdefault("goal_edit_seq", 20)
            for field in ("title", "priority", "status", "success_criteria"):
                if isinstance(body, dict) and field in body:
                    seq += 1
                    manual[field] = {"at_seq": 0, "edit": seq}
            holder["goal_edit_seq"] = seq
            updated = {**stored, **(body or {}), "goal_id": goal_id, "manual": manual}
            holder["profile"]["goals"] = [
                updated if g["goal_id"] == goal_id else g for g in goals]
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(updated))

        if path.startswith("/api/learner/profile/knowledge/"):
            concept_id = path.rsplit("/", 1)[-1]
            if holder["knowledge_fail"]:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "服务端暂时不可用"}))
            states = holder["profile"]["knowledge_states"]
            stored = next((s for s in states if s["concept_id"] == concept_id), None) or state(concept_id, concept_id)
            updated = {**stored, **(body or {}), "concept_id": concept_id, "origin": "manual"}
            holder["profile"]["knowledge_states"] = [
                updated if s["concept_id"] == concept_id else s for s in states]
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(updated))

        if path == "/api/courses":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(COURSE_LIST))
        if path == "/api/courses/course_a/learner":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder.get("course_a", COURSE_A)))
        if path == "/api/courses/daily":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"date": "2026-11-24", "daily_minutes": 30,
                                                  "courses": [], "notes": []}))
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

    page.route(API_ROUTE, handler)
    return requests


def open_page(browser, *, width, height, profile_payload, lang="zh-CN", theme="light"):
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(
        f"localStorage.setItem('inno.theme', {json.dumps(theme)});"
        f"localStorage.setItem('inno.locale', {json.dumps(lang)});"
    )
    holder = {"profile": json.loads(json.dumps(profile_payload))}
    requests = install_routes(page, holder)
    page.goto(BASE, wait_until="networkidle")
    page.locator(".mla-profile-container").wait_for(state="visible", timeout=15000)
    # Above five rows the knowledge section starts collapsed, so its rows — and
    # their provenance blocks — are not in the DOM until it is opened.
    p26.expand_knowledge(page)
    return page, errors, holder, requests


def goal_card(page: Page, title: str):
    return goal_section(page).locator("div.rounded-xl", has_text=title).first


def goal_record(holder: dict, goal_id: str) -> dict:
    return next(g for g in holder["profile"]["goals"] if g["goal_id"] == goal_id)


def priority_stamp(holder: dict, goal_id: str) -> dict | None:
    return (goal_record(holder, goal_id).get("manual") or {}).get("priority")


def open_goal_editor(card) -> object:
    """Open the editor and return the card handle.

    Opening the editor replaces the card's *contents*, so the title text the
    locator matched on disappears; React reuses the same `div`, which keeps the
    handle valid.
    """
    handle = card.element_handle()
    card.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    return handle


def editor_buttons(handle) -> dict[str, object]:
    buttons = handle.query_selector_all("button")
    out = {}
    for button in buttons:
        text = (button.inner_text() or "").strip()
        out[text] = button
    return out


def save_goal(handle):
    buttons = editor_buttons(handle)
    button = buttons.get("保存") or buttons.get("Save")
    ensure(button is not None, f"no save button, have {list(buttons)}")
    button.click()


def cancel_goal(handle):
    buttons = editor_buttons(handle)
    button = buttons.get("取消") or buttons.get("Cancel")
    ensure(button is not None, f"no cancel button, have {list(buttons)}")
    button.click()


def goal_patch_bodies(requests: list[dict], goal_id: str) -> list[dict]:
    return [r["body"] for r in requests
            if r["method"] == "PATCH" and r["path"].endswith(f"/goals/{goal_id}")]


def record(page: Page, filename: str, *, scenario: str, viewport: str, theme: str,
           lang: str, errors: list[str], extra=None) -> dict:
    data = measure(page)
    data.update({"file": filename, "scenario": scenario, "viewport": viewport,
                 "theme": theme, "lang": lang, "pageErrors": list(errors)})
    if extra:
        data.update(extra)
    return data


def save_shot(page: Page, name: str):
    page.screenshot(path=str(R1_DIR / name), full_page=False)


def save_block_shot(page: Page, locator, name: str):
    """Capture one block in full, even when it is taller than the viewport.

    A viewport screenshot of a tall block either cuts its top (the origin label)
    or its bottom (the evidence caveat); either way the picture would not show
    what the scenario asserts, even though the assertions themselves passed on
    the measured bounds. The clip is taken in *page* coordinates against a
    full-page capture, so a block taller than the 640px viewport is still
    captured whole rather than cut at the fold.
    """
    locator.evaluate("el => el.scrollIntoView({block: 'center'})")
    page.wait_for_timeout(250)
    rect = locator.evaluate(
        """(el) => {
            const b = el.getBoundingClientRect();
            return {width: b.width, height: b.height};
        }"""
    )
    ensure(rect["width"] > 0 and rect["height"] > 0, f"no box for {name}")
    locator.screenshot(path=str(R1_DIR / name))


# ---------------------------------------------------------------------------
# R01-R05: the goal editor's write scope
# ---------------------------------------------------------------------------

def r01_title_only_anomaly(browser, out):
    """R01: priority 3, edit only the title — no priority key, no new stamp."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before_goal = json.loads(json.dumps(goal_record(holder, "g_anomaly")))
    stamp_before = priority_stamp(holder, "g_anomaly")
    card = goal_card(page, "背完核心词表")
    handle = open_goal_editor(card)
    page.wait_for_timeout(250)
    handle.query_selector("input:not([type=range])").fill("改过标题的词表")
    page.wait_for_timeout(120)
    save_goal(handle)
    page.wait_for_timeout(600)

    bodies = goal_patch_bodies(requests, "g_anomaly")
    ensure(len(bodies) == 1, f"R01: expected one goal PATCH, got {len(bodies)}")
    body = bodies[0]
    ensure("priority" not in body,
           f"R01: a title-only save sent priority={body.get('priority')!r}; the key must be absent")
    ensure(body.get("title") == "改过标题的词表", f"R01: title body {body!r}")

    after_goal = goal_record(holder, "g_anomaly")
    ensure(after_goal["priority"] == 3,
           f"R01: stored priority became {after_goal['priority']!r}, expected 3")
    ensure(priority_stamp(holder, "g_anomaly") == stamp_before,
           f"R01: manual.priority moved {stamp_before} -> {priority_stamp(holder, 'g_anomaly')}")

    page.wait_for_timeout(200)
    save_shot(page, "r1-r01-title-only-anomaly.png")
    data = record(page, "r1-r01-title-only-anomaly.png", scenario="R01", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors,
                  extra={
                      "goalBefore": before_goal,
                      "userEditedFields": ["title"],
                      "patchFields": sorted(body.keys()),
                      "patchBody": body,
                      "prioritySubmitted": "priority" in body,
                      "goalAfter": after_goal,
                      "manualPriorityBefore": stamp_before,
                      "manualPriorityAfter": priority_stamp(holder, "g_anomaly"),
                      "manualPriorityUnchanged": priority_stamp(holder, "g_anomaly") == stamp_before,
                  })
    ensure(not errors, f"R01: page errors {errors}")
    out.append(data)
    page.close()


def r02_status_only_normal(browser, out):
    """R02: priority 0.5, edit only the status — no priority key."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before_goal = json.loads(json.dumps(goal_record(holder, "g_normal")))
    stamp_before = priority_stamp(holder, "g_normal")
    card = goal_card(page, "读完 CET4")
    handle = open_goal_editor(card)
    page.wait_for_timeout(250)

    # The status <Select> is the second combobox in the editor (type is first).
    combos = handle.query_selector_all("[role=combobox]")
    ensure(len(combos) >= 2, f"R02: expected two selects, got {len(combos)}")
    combos[1].click()
    page.wait_for_timeout(200)
    page.get_by_role("option", name="已暂停").click()
    page.wait_for_timeout(200)
    save_goal(handle)
    page.wait_for_timeout(600)

    bodies = goal_patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 1, f"R02: expected one goal PATCH, got {len(bodies)}")
    body = bodies[0]
    ensure("priority" not in body, f"R02: a status-only save sent {body!r}")
    ensure(body.get("status") == "paused", f"R02: status body {body!r}")

    after_goal = goal_record(holder, "g_normal")
    ensure(after_goal["priority"] == 0.5,
           f"R02: stored priority became {after_goal['priority']!r}")
    ensure(priority_stamp(holder, "g_normal") == stamp_before,
           "R02: manual.priority moved on a status-only save")

    save_shot(page, "r1-r02-status-only-normal.png")
    data = record(page, "r1-r02-status-only-normal.png", scenario="R02", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors,
                  extra={
                      "goalBefore": before_goal,
                      "userEditedFields": ["status"],
                      "patchFields": sorted(body.keys()),
                      "patchBody": body,
                      "prioritySubmitted": "priority" in body,
                      "goalAfter": after_goal,
                      "manualPriorityBefore": stamp_before,
                      "manualPriorityAfter": priority_stamp(holder, "g_normal"),
                      "manualPriorityUnchanged": priority_stamp(holder, "g_normal") == stamp_before,
                  })
    ensure(not errors, f"R02: page errors {errors}")
    out.append(data)
    page.close()


def r03_active_change(browser, out):
    """R03: an anomalous priority changed on purpose — 0, 0.4 and 1."""
    results = []
    # 0 and 0.4 come from moving the slider; 1 is the track end the thumb already
    # occupies, so it is reached through the explicit endpoint button.
    plan = [
        ("slider", "0", 0),
        ("slider", "40", 0.4),
        ("endpoint", None, 1),
    ]
    for mode, slider_value, expected in plan:
        page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                                   profile_payload=PROFILE_ZH)
        goal_section(page).scroll_into_view_if_needed()
        page.wait_for_timeout(200)
        stamp_before = priority_stamp(holder, "g_anomaly")
        card = goal_card(page, "背完核心词表")
        handle = open_goal_editor(card)
        page.wait_for_timeout(250)

        slider = handle.query_selector("input[type=range]")
        ensure(slider is not None, "R03: no priority slider")
        if mode == "slider":
            # Real keyboard input, not a synthetic event: React's value tracker
            # ignores a dispatched `change` after a direct `el.value` write, so a
            # scripted assignment would prove nothing about a user's drag.
            # Home parks the thumb at 0; ArrowRight steps by one percent.
            slider.focus()
            page.keyboard.press("Home")
            for _ in range(int(slider_value)):
                page.keyboard.press("ArrowRight")
            page.wait_for_timeout(200)
        else:
            buttons = editor_buttons(handle)
            endpoint = next((b for t, b in buttons.items() if t.startswith("将优先级设为 100%")), None)
            ensure(endpoint is not None,
                   f"R03: no endpoint button, have {list(buttons)}")
            endpoint.click()
            page.wait_for_timeout(200)

        save_goal(handle)
        page.wait_for_timeout(600)

        bodies = goal_patch_bodies(requests, "g_anomaly")
        ensure(len(bodies) == 1, f"R03/{mode}: expected one PATCH, got {len(bodies)}")
        body = bodies[0]
        ensure(body.get("priority") == expected,
               f"R03/{mode}: sent priority={body.get('priority')!r}, expected {expected}")
        after_goal = goal_record(holder, "g_anomaly")
        ensure(after_goal["priority"] == expected,
               f"R03/{mode}: stored priority {after_goal['priority']!r}")
        ensure(priority_stamp(holder, "g_anomaly") != stamp_before,
               f"R03/{mode}: manual.priority did not advance for an explicit change")

        shot = f"r1-r03-{'slider' if mode == 'slider' else 'endpoint'}-{str(expected).replace('.', '_')}.png"
        save_shot(page, shot)
        results.append({
            "mode": mode,
            "sliderValue": slider_value,
            "chosen": expected,
            "patchFields": sorted(body.keys()),
            "patchBody": body,
            "prioritySubmitted": True,
            "goalAfter": after_goal,
            "manualPriorityBefore": stamp_before,
            "manualPriorityAfter": priority_stamp(holder, "g_anomaly"),
            "manualPriorityAdvanced": priority_stamp(holder, "g_anomaly") != stamp_before,
            "file": shot,
            "pageErrors": list(errors),
        })
        ensure(not errors, f"R03/{mode}: page errors {errors}")
        page.close()

    out.append({"scenario": "R03", "viewport": "1440x900", "theme": "light", "lang": "zh-CN",
                "pageErrors": [], "runs": results})


def r04_passive_update(browser, out):
    """R04: the server moves the priority while the editor is open.

    A title-only save must neither overwrite the newer value nor claim the field.
    """
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before_goal = json.loads(json.dumps(goal_record(holder, "g_normal")))
    card = goal_card(page, "读完 CET4")
    handle = open_goal_editor(card)
    page.wait_for_timeout(250)
    handle.query_selector("input:not([type=range])").fill("编辑期间改了标题")
    page.wait_for_timeout(150)

    # The server (another tab, or a projection) moves the priority to 0.9, with a
    # newer stamp. The editor must not have captured the old value.
    record_ = goal_record(holder, "g_normal")
    record_["priority"] = 0.9
    record_["manual"] = {**(record_.get("manual") or {}),
                         "priority": {"at_seq": 0, "edit": 99}}
    server_priority = 0.9
    page.get_by_role("button", name=re.compile(r"^刷新$|^Refresh$")).click()
    page.wait_for_timeout(700)

    save_goal(handle)
    page.wait_for_timeout(600)

    bodies = goal_patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 1, f"R04: expected one PATCH, got {len(bodies)}")
    body = bodies[0]
    ensure("priority" not in body, f"R04: the save sent priority={body.get('priority')!r}")
    after_goal = goal_record(holder, "g_normal")
    ensure(after_goal["priority"] == server_priority,
           f"R04: stored priority is {after_goal['priority']!r}, the server's 0.9 was overwritten")
    ensure(priority_stamp(holder, "g_normal") == {"at_seq": 0, "edit": 99},
           f"R04: the server's newer stamp was replaced: {priority_stamp(holder, 'g_normal')}")

    save_shot(page, "r1-r04-passive-update.png")
    data = record(page, "r1-r04-passive-update.png", scenario="R04", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors,
                  extra={
                      "goalBefore": before_goal,
                      "serverPriorityDuringEdit": server_priority,
                      "userEditedFields": ["title"],
                      "patchFields": sorted(body.keys()),
                      "patchBody": body,
                      "prioritySubmitted": "priority" in body,
                      "goalAfter": after_goal,
                      "manualPriorityAfter": priority_stamp(holder, "g_normal"),
                      "newerPrioritySurvived": after_goal["priority"] == server_priority,
                  })
    ensure(not errors, f"R04: page errors {errors}")
    out.append(data)
    page.close()


def r05_cancel_and_failure(browser, out):
    """R05: cancel sends nothing; a failed save keeps the draft and the value."""
    # --- cancel ---
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    card = goal_card(page, "背完核心词表")
    handle = open_goal_editor(card)
    page.wait_for_timeout(250)
    handle.query_selector("input:not([type=range])").fill("临时改的标题")
    page.wait_for_timeout(150)
    cancel_goal(handle)
    page.wait_for_timeout(400)

    ensure(not goal_patch_bodies(requests, "g_anomaly"), "R05: cancel issued a PATCH")
    after_cancel = measure(page)
    cancelled = next(g for g in after_cancel["goals"] if "背完核心词表" in (g["text"] or ""))
    ensure(cancelled["priorityLine"].endswith("优先级异常 · 原始值 3"),
           f"R05: after cancel the line reads {cancelled['priorityLine']!r}")
    save_shot(page, "r1-r05-cancel.png")
    cancel_data = record(page, "r1-r05-cancel.png", scenario="R05/cancel", viewport="1440x900",
                         theme="light", lang="zh-CN", errors=errors,
                         extra={"patchCount": 0, "lineAfterCancel": cancelled["priorityLine"]})
    ensure(not errors, f"R05/cancel: page errors {errors}")
    page.close()

    # --- failure ---
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    holder["goal_fail"] = True
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    stamp_before = priority_stamp(holder, "g_anomaly")
    card = goal_card(page, "背完核心词表")
    handle = open_goal_editor(card)
    page.wait_for_timeout(250)
    handle.query_selector("input:not([type=range])").fill("没保存的标题")
    slider = handle.query_selector("input[type=range]")
    slider.focus()
    page.keyboard.press("Home")
    for _ in range(40):
        page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)
    save_goal(handle)
    page.wait_for_timeout(800)

    # The goal card renders its error as a plain styled div (unlike the
    # knowledge editor, which uses `role="alert"`), so it is read by text.
    handle_text = handle.inner_text() or ""
    ensure("服务端暂时不可用" in handle_text,
           f"R05: no failure message after a rejected save, card reads {handle_text!r}")
    alert_text = next((line.strip() for line in handle_text.splitlines()
                       if "服务端暂时不可用" in line), "")
    draft_title = handle.query_selector("input:not([type=range])").input_value()
    ensure(draft_title == "没保存的标题", f"R05: draft lost, title={draft_title!r}")
    slider_now = handle.query_selector("input[type=range]").input_value()
    ensure(slider_now == "40", f"R05: chosen priority lost, slider={slider_now!r}")
    bodies = goal_patch_bodies(requests, "g_anomaly")
    ensure(len(bodies) == 1, f"R05: expected one attempt, got {len(bodies)}")
    ensure(bodies[0].get("priority") == 0.4,
           f"R05: the attempt sent {bodies[0]!r}")
    ensure(goal_record(holder, "g_anomaly")["priority"] == 3,
           "R05: a failed save changed the stored priority")
    ensure(priority_stamp(holder, "g_anomaly") == stamp_before,
           "R05: a failed save advanced manual.priority")

    save_shot(page, "r1-r05-save-failed.png")
    fail_data = record(page, "r1-r05-save-failed.png", scenario="R05/failure", viewport="1440x900",
                       theme="light", lang="zh-CN", errors=errors,
                       extra={"patchCount": len(bodies), "patchBody": bodies[0],
                              "draftRetained": draft_title, "sliderRetained": slider_now,
                              "alertText": alert_text,
                              "storedPriorityAfterFailure": goal_record(holder, "g_anomaly")["priority"]})
    ensure(not errors, f"R05/failure: page errors {errors}")
    page.close()
    out.append({"scenario": "R05", "viewport": "1440x900", "theme": "light", "lang": "zh-CN",
                "pageErrors": [], "cancel": cancel_data, "failure": fail_data})


# ---------------------------------------------------------------------------
# R06-R08: the course region notes and the evidence array boundary
# ---------------------------------------------------------------------------

def open_course(page: Page, course_title: str, heading: str):
    page.get_by_label(re.compile(r"选择学习档案范围|Profile scope")).focus()
    page.keyboard.press("Enter")
    page.get_by_role("option", name=course_title).click()
    page.get_by_role("heading", name=heading).wait_for(state="visible", timeout=15000)
    page.wait_for_timeout(400)


def r06_course_notes_320(browser, out):
    """R06: 320px — the course evidence caveats, once, above the list."""
    page, errors, holder, requests = open_page(browser, width=320, height=640,
                                               profile_payload=PROFILE_ZH)
    open_course(page, "同义替换", "知识掌握")
    card = page.locator("section", has=page.get_by_role("heading", name="知识掌握"))
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(250)

    notes = card.locator(".mla-provenance__region-notes")
    ensure(notes.count() == 1, f"R06: expected one region note block, got {notes.count()}")
    note_text = notes.first.inner_text()
    ensure("不代表证据质量或可信度认证" in note_text, f"R06: origin caveat missing: {note_text!r}")
    ensure("不等于独立学习或练习次数" in note_text, f"R06: evidence caveat missing: {note_text!r}")
    ensure("当前暂不提供证据明细" in note_text, f"R06: 'no detail' note missing: {note_text!r}")
    # Once per region, not once per row.
    body_text = card.inner_text()
    ensure(body_text.count("不等于独立学习或练习次数") == 1,
           "R06: the evidence caveat is repeated per row")

    # 320px: the note block must be fully readable, not clipped.
    box = notes.first.evaluate(
        """(el) => {
            const b = el.getBoundingClientRect();
            const out = [];
            for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
                const cs = getComputedStyle(n);
                if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
                const nb = n.getBoundingClientRect();
                if (nb.width <= 0) continue;
                out.push({cls: (n.className || '').toString().slice(0, 40),
                          left: nb.left, right: nb.right});
            }
            return {width: b.width, height: b.height, left: b.left, right: b.right,
                    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
                    clippedBy: out.filter((c) => b.left < c.left - 1 || b.right > c.right + 1)};
        }"""
    )
    ensure(box["width"] > 0 and box["height"] > 0, "R06: the note block has no box")
    ensure(not box["clippedBy"], f"R06: the note block is clipped {box['clippedBy']}")
    ensure(box["scrollWidth"] <= box["clientWidth"] + 1,
           f"R06: the note text overflows its box {box['scrollWidth']}>{box['clientWidth']}")

    course = measure_course(page)
    ensure(not course["document"]["overflowsHorizontally"], "R06: page overflows horizontally")
    ensure(not course["list"]["overflowsHorizontally"], "R06: course list overflows horizontally")
    for row in course["rows"]:
        ensure(not row["row"]["clippedBy"], f"R06 / {row['name']!r}: row clipped")
        ensure(not row["hasEditor"], f"R06 / {row['name']!r}: the course view is not read-only")
        # The per-row block keeps its facts but not the paragraphs.
        ensure(row["originLabel"], f"R06 / {row['name']!r}: no origin label")
        ensure(row["provenanceText"] and "不等于独立学习" not in (row["provenanceText"] or ""),
               f"R06 / {row['name']!r}: the caveat was repeated inside the row")

    # Frame the capture on the note block itself: a screenshot of the rows below
    # it would not show the thing this scenario is about.
    notes.first.evaluate("el => el.scrollIntoView({block: 'center'})")
    page.wait_for_timeout(250)
    # Frame the capture on the note block itself: a screenshot of the rows below
    # it would not show the thing this scenario is about.
    notes.first.evaluate("el => el.scrollIntoView({block: 'center'})")
    page.wait_for_timeout(250)
    save_shot(page, "r1-r06-320-course-notes.png")
    out.append({"scenario": "R06", "viewport": "320x640", "theme": "light", "lang": "zh-CN",
                "file": "r1-r06-320-course-notes.png",
                "noteText": note_text, "noteBox": box,
                "regionNoteCount": notes.count(),
                "pageErrors": list(errors), **course})
    ensure(not errors, f"R06: page errors {errors}")
    page.close()

    # Dark theme: the same block, measured rather than eyeballed. The notes reuse
    # `.mla-provenance__hint`, so this is the only new surface whose contrast
    # could differ from the reading view's.
    page, errors, holder, requests = open_page(browser, width=320, height=640,
                                               profile_payload=PROFILE_ZH, theme="dark")
    open_course(page, "同义替换", "知识掌握")
    card = page.locator("section", has=page.get_by_role("heading", name="知识掌握"))
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    contrast = card.locator(".mla-provenance__region-notes .mla-provenance__hint").first.evaluate(
        """(el) => {
            const parse = (v) => {
                const m = (v || '').match(/rgba?\\(([^)]+)\\)/);
                if (!m) return null;
                const p = m[1].split(',').map((x) => parseFloat(x.trim()));
                return {r: p[0], g: p[1], b: p[2]};
            };
            const bgOf = (n) => {
                for (let c = n; c; c = c.parentElement) {
                    const bg = getComputedStyle(c).backgroundColor;
                    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
                }
                return getComputedStyle(document.body).backgroundColor;
            };
            const lum = (c) => {
                const f = (v) => {
                    const s = v / 255;
                    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                };
                return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
            };
            const fg = parse(getComputedStyle(el).color);
            const bg = parse(bgOf(el));
            if (!fg || !bg) return null;
            const a = lum(fg), b = lum(bg);
            const hi = Math.max(a, b), lo = Math.min(a, b);
            return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
        }"""
    )
    ensure(contrast is not None, "R06/dark: could not measure the note contrast")
    ensure(contrast >= 4.5, f"R06/dark: note contrast {contrast} < 4.5")
    notes = card.locator(".mla-provenance__region-notes")
    ensure(notes.count() == 1, f"R06/dark: expected one note block, got {notes.count()}")
    notes.first.evaluate("el => el.scrollIntoView({block: 'center'})")
    page.wait_for_timeout(250)
    save_shot(page, "r1-r06-dark-320-course-notes.png")
    out.append({"scenario": "R06/dark", "viewport": "320x640", "theme": "dark", "lang": "zh-CN",
                "file": "r1-r06-dark-320-course-notes.png",
                "regionNoteCount": notes.count(), "noteContrast": contrast,
                "pageErrors": list(errors)})
    ensure(not errors, f"R06/dark: page errors {errors}")
    page.close()


def r07_english_320(browser, out):
    """R07: 320px English — the new unknown-source wording and the notes."""
    # Width is the constraint under test; the taller viewport only lets the
    # capture show a block that is longer than a phone screen without the fixed
    # bottom bar painting over its last lines.
    page, errors, holder, requests = open_page(browser, width=320, height=1400,
                                               profile_payload=PROFILE_EN, lang="en")
    holder["course_a"] = COURSE_A_EN
    expand_all_rows(page)
    data = record(page, "r1-r07-320-en-unknown.png", scenario="R07", viewport="320x640",
                  theme="light", lang="en", errors=errors)
    show_provenance(page, "Connector logic")
    page.wait_for_timeout(250)

    check_provenance(data, where="R07 320-en")
    prov = row_by_name(data, "Connector logic")["provenance"]
    block = knowledge_section(page).locator(".mla-knowledge-row", has_text="Connector logic").first \
        .locator(".mla-provenance").first
    ensure(prov["unknownBadge"] == "Source unknown", "R07: English unknown badge missing")
    expected = ("This record contains historical information whose provenance cannot be confirmed. "
                "This flag does not establish evidence quality or the accuracy of the knowledge assessment.")
    ensure(any(expected in (hint or "") for hint in prov["hints"]),
           f"R07: the new unknown-source wording is missing, hints={prov['hints']}")
    ensure(not any("could not trace" in (hint or "") for hint in prov["hints"]),
           "R07: the old 'could not trace' wording is still rendered")
    ensure(any("not the number of separate study or practice sessions" in (hint or "")
               for hint in prov["hints"]),
           f"R07: the evidence caveat is missing, hints={prov['hints']}")

    body = page.locator("body").inner_text()
    for leaked in ["来源不明", "证据标识", "来源无法确认"]:
        ensure(leaked not in body, f"R07: Chinese {leaked!r} leaked into the English layout")

    save_block_shot(page, block, "r1-r07-320-en-unknown.png")
    out.append({**data, "unknownHintExpected": expected, "unknownHints": prov["hints"]})
    ensure(not errors, f"R07: page errors {errors}")
    page.close()


def r08_bad_evidence_arrays(browser, out):
    """R08: a damaged evidence array reads as unavailable, never a count."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_BAD_EVIDENCE)
    expand_all_rows(page)
    data = record(page, "r1-r08-bad-evidence.png", scenario="R08", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors)
    show_provenance(page, "空值元素")
    page.wait_for_timeout(250)

    check_provenance(data, where="R08")
    broken = {
        "空值元素": "[null]",
        "数字元素": "[123]",
        "对象元素": "[{}]",
        "混合空值": '["evt_1", null]',
        "混合数字": '["evt_1", 123]',
        "空白标识": '[""]',
    }
    observed = {}
    for name, shape in broken.items():
        prov = row_by_name(data, name)["provenance"]
        observed[name] = {"shape": shape,
                          "evidenceText": prov["evidenceText"],
                          "evidenceCount": prov["evidenceCount"]}
        ensure(prov["evidenceText"] == "证据标识数量不可用",
               f"R08 / {name}: {shape} reads {prov['evidenceText']!r}, expected unavailable")
        ensure(prov["evidenceCount"] == "unavailable",
               f"R08 / {name}: count attribute {prov['evidenceCount']!r}")
        ensure("证据标识 1 个" not in (prov["text"] or ""),
               f"R08 / {name}: a filtered count was rendered")

    good = row_by_name(data, "正常标识")["provenance"]
    ensure(good["evidenceText"] == "证据标识 2 个",
           f"R08: a valid array must still count, got {good['evidenceText']!r}")

    save_shot(page, "r1-r08-bad-evidence.png")
    out.append({**data, "badArrays": observed,
                "goodArray": {"evidenceText": good["evidenceText"],
                              "evidenceCount": good["evidenceCount"]}})
    ensure(not errors, f"R08: page errors {errors}")
    page.close()


# ---------------------------------------------------------------------------
# B01-B10 rerun (corrected B09)
# ---------------------------------------------------------------------------

def b03_unknown_source_r1(browser, out):
    """B03 rerun with the corrected expectation.

    The original B03 asserts the old hint text (「服务端未能追溯…」), which F03
    replaces on purpose. The scenario is otherwise unchanged: 320px, Chinese, the
    legacy record showing both the origin label and the unknown flag, nothing
    clipped.
    """
    page, errors, holder, requests = open_page(browser, width=320, height=640,
                                               profile_payload=PROFILE_ZH)
    open_row(page, "连接词逻辑")
    page.wait_for_timeout(200)
    data = record(page, "r1-b03-320-unknown.png", scenario="B03", viewport="320x640",
                  theme="light", lang="zh-CN", errors=errors)
    show_provenance(page, "连接词逻辑")
    save_shot(page, "r1-b03-320-unknown.png")

    check_provenance(data, where="B03 320")
    legacy = row_by_name(data, "连接词逻辑")["provenance"]
    ensure(legacy["originLabel"] == "历史记录", f"B03: origin {legacy['originLabel']!r}")
    ensure(legacy["unknownBadge"] == "来源不明", "B03: unknown badge missing")
    # CORRECTED: the flag now describes the record, not a trace operation.
    ensure(any("来源无法确认的历史信息" in h for h in legacy["hints"]),
           f"B03: the unknown-source hint is missing, hints={legacy['hints']}")
    ensure(not any("服务端未能追溯" in h for h in legacy["hints"]),
           "B03: the removed 'trace' wording is still rendered")
    ensure("来源不明" in (legacy["text"] or ""), "B03: badge text not in the block")
    ensure(not legacy["badgeBox"]["clippedBy"], "B03: badge clipped at 320px")
    ensure(not errors, f"B03: page errors {errors}")
    out.append({**data, "expectationCorrected": (
        "P2-6 B03 asserted 「服务端未能追溯」; F03 replaced it with the record-level wording.")})
    page.close()


def b09_goal_priority_r1(browser, out):
    """B09 rerun with the corrected expectation.

    The original B09 asserted the title-only save sent `priority: 3`. That is the
    behaviour F01 removes: the field must be absent from the body, and the stored
    value must still be 3. Everything else in the original scenario is kept.
    """
    page, errors, holder, requests = p26.open_page(browser, width=1440, height=900,
                                                   profile_payload=PROFILE_ZH)
    section = goal_section(page)
    section.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    data = record(page, "r1-b09-priority.png", scenario="B09", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors)
    save_shot(page, "r1-b09-priority.png")

    anomaly_card = next(g for g in data["goals"] if g["priorityLine"] and "背完核心词表" in (g["text"] or ""))
    normal_card = next(g for g in data["goals"] if g["priorityLine"] and "读完 CET4" in (g["text"] or ""))
    ensure(anomaly_card["priorityLine"].endswith("优先级异常 · 原始值 3"),
           f"B09: anomaly line reads {anomaly_card['priorityLine']!r}")
    ensure("300%" not in (anomaly_card["text"] or ""), "B09: 300% must never be rendered")
    ensure("优先级 100%" not in (anomaly_card["text"] or ""),
           "B09: the anomaly must not be silently clamped to 100%")
    ensure(normal_card["priorityLine"].endswith("优先级 50%"),
           f"B09: the normal goal reads {normal_card['priorityLine']!r}")

    card = section.locator("div.rounded-xl", has_text="背完核心词表").first
    card_handle = card.element_handle()
    card.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(250)
    slider = card_handle.query_selector("input[type=range]")
    ensure(slider is not None, "B09: the editor has no priority slider")
    slider_value = slider.input_value()
    editor_text = card_handle.inner_text()
    ensure(slider_value == "100", f"B09: slider parked at {slider_value!r}, expected 100")
    ensure("优先级异常 · 原始值 3" in editor_text,
           f"B09: the editor label lost the raw value: {editor_text!r}")
    ensure("该目标的优先级超出正常范围" in editor_text,
           "B09: the anomaly hint is missing in the editor")

    card_handle.query_selector("input:not([type=range])").fill("改过标题的词表")
    page.wait_for_timeout(120)
    save_goal(card_handle)
    page.wait_for_timeout(600)
    goal_writes = requests_to(requests, "/api/learner/profile/goals/g_anomaly")
    ensure(len(goal_writes) == 1, f"B09: expected one goal PATCH, got {len(goal_writes)}")
    # CORRECTED: the key is absent, not re-sent with the old value.
    ensure("priority" not in goal_writes[0]["body"],
           f"B09: a title-only save sent priority={goal_writes[0]['body'].get('priority')!r}; "
           "the key must be absent")
    stored = next(g for g in holder["profile"]["goals"] if g["goal_id"] == "g_anomaly")
    ensure(stored["priority"] == 3, f"B09: stored priority became {stored['priority']!r}")

    after_save = measure(page)
    saved = next(g for g in after_save["goals"] if "改过标题的词表" in (g["text"] or ""))
    ensure(saved["priorityLine"].endswith("优先级异常 · 原始值 3"),
           f"B09: after saving the title, the line reads {saved['priorityLine']!r}")

    normal = section.locator("div.rounded-xl", has_text="读完 CET4").first
    normal_handle = normal.element_handle()
    normal.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(200)
    normal_handle.query_selector("input:not([type=range])").fill("临时改的标题")
    page.wait_for_timeout(120)
    cancel_goal(normal_handle)
    page.wait_for_timeout(400)
    ensure(len(requests_to(requests, "/api/learner/profile/goals/g_normal")) == 0,
           "B09: cancelling issued a PATCH")
    after_cancel = measure(page)
    cancelled = next(g for g in after_cancel["goals"] if "读完 CET4" in (g["text"] or ""))
    ensure(cancelled["priorityLine"].endswith("优先级 50%"),
           f"B09: after cancel the line reads {cancelled['priorityLine']!r}")
    ensure("临时改的标题" not in (cancelled["text"] or ""), "B09: cancel kept the edited title")
    ensure(not errors, f"B09: page errors {errors}")

    out.append({**record(page, "r1-b09-priority.png", scenario="B09", viewport="1440x900",
                         theme="light", lang="zh-CN", errors=errors),
                "anomalyLine": anomaly_card["priorityLine"],
                "normalLine": normal_card["priorityLine"],
                "sliderValueForAnomaly": slider_value,
                "titleOnlySavePatchFields": sorted(goal_writes[0]["body"].keys()),
                "titleOnlySaveSendsPriority": "priority" in goal_writes[0]["body"],
                "storedPriorityAfterSave": stored["priority"],
                "lineAfterTitleSave": saved["priorityLine"],
                "lineAfterCancel": cancelled["priorityLine"],
                "goalSaveRequests": len(requests_to(requests, "/api/learner/profile/goals/")),
                "expectationCorrected": (
                    "P2-6 B09 asserted the body re-sent priority=3; R1 asserts the key is "
                    "absent and the stored value is unchanged."
                )})
    page.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    R1_DIR.mkdir(parents=True, exist_ok=True)
    # The imported P2-6 scenarios write screenshots through their module-level
    # ASSETS; pointing it at the R1 directory keeps the original evidence intact.
    p26.ASSETS = R1_DIR
    p26.METRICS = METRICS

    out: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            # --- R1 fixes ---
            r01_title_only_anomaly(browser, out)
            r02_status_only_normal(browser, out)
            r03_active_change(browser, out)
            r04_passive_update(browser, out)
            r05_cancel_and_failure(browser, out)
            r06_course_notes_320(browser, out)
            r07_english_320(browser, out)
            r08_bad_evidence_arrays(browser, out)

            # --- P2-6 B01-B10 rerun ---
            b01 = []
            p26.b01_1440_all_courses(browser, b01)
            p26.b02_390_stacked(browser, b01)
            b03_unknown_source_r1(browser, b01)
            p26.b04_320_english(browser, b01)
            p26.b05_dark(browser, b01)
            p26.b06_manual_save_success(browser, b01)
            p26.b07_save_failure(browser, b01)
            p26.b08_legacy_mirror(browser, b01)
            b09 = []
            b09_goal_priority_r1(browser, b09)
            p26.b10_course_320(browser, b01)
            out.extend(b01)
            out.extend(b09)

            METRICS.write_text(json.dumps({
                "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
                "base": BASE,
                "note": ("E4.9i-P2-6-R1. R01-R08 cover the R1 fixes; B01-B10 re-run the "
                         "P2-6 scenarios from this script with B09's expectation corrected "
                         "(a title-only save sends no priority key). The original "
                         "P2-6-assets/p26-browser-metrics.json and its screenshots are "
                         "untouched."),
                "scenarios": out,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(out)} scenario entries -> {METRICS}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
