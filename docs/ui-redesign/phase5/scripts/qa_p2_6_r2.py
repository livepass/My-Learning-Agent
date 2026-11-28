"""E4.9i-P2-6-R2 browser acceptance: the goal editor's opening snapshot.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_6_r2.py

What this script covers
-----------------------

* **R2-B01 … R2-B07** — the R2 fix. The editor keeps a snapshot of the record it
  opened with and sends only fields the *user* changed. Every scenario changes
  the server's record while the editor is open (another tab, a projection, a
  refresh) and asserts the whole PATCH body, the stored record afterwards and
  the `manual.*` ownership stamps.
* **R1 rerun** — all 19 P2-6-R1 scenarios, executed from the R1 module itself so
  the two rounds are comparable. Their screenshots go to `r2/r1-rerun/`; the
  original `r1/` and `P2-6-assets/*.png` evidence is not touched.

Evidence boundary (stated again in the report)
----------------------------------------------

Every `/api` request is answered by `page.route` fixtures. The goal PATCH fixture
emulates the ownership rule in `server/routes/learner.ts`: a field's
`manual.<field>.edit` advances only when the request body contains that field.
That makes the *request body* observable from the browser.

This is **simulated-API browser evidence**. It is not proof about the real
route: the server half of the contract is pinned by the Vitest route tests in
`apps/learning-agent/src/server/routes/learner.goal-priority.test.ts`, which run
the real handler against a real learner store on disk.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_p2_6 as p26  # noqa: E402
import qa_p2_6_r1 as r1  # noqa: E402

BASE = p26.BASE
PHASE = p26.PHASE
ASSETS = PHASE / "P2-6-assets"
R2_DIR = ASSETS / "r2"
R2_RERUN_DIR = R2_DIR / "r1-rerun"
METRICS = ASSETS / "r2-browser-metrics.json"

ensure = p26.ensure
requests_to = p26.requests_to
measure = p26.measure
goal_section = p26.goal_section

#: Every scenario viewport is recorded with its measurements, so the report can
#: state which size the bounds were taken at.
PROFILE_ZH = r1.PROFILE_ZH

#: Fields the mock server can claim ownership of, matching the real route
#: (`server/routes/learner.ts` stamps title / priority / status /
#: success_criteria; `type` has no stamp at all).
STAMPED_FIELDS = ("title", "priority", "status", "success_criteria")

#: A window snapshot for the goal editor: boxes of everything a 320px check
#: cares about, plus whether any ancestor clips them.
R2_PROBE = """() => {
  const round = (n) => Math.round(n * 10) / 10;
  const clippersOf = (el) => {
    const out = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = n.getBoundingClientRect();
      if (b.width <= 0) continue;
      out.push({cls: (n.className || '').toString().slice(0, 50),
                left: round(b.left), right: round(b.right)});
    }
    return out;
  };
  const describe = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {width: round(b.width), height: round(b.height),
            left: round(b.left), right: round(b.right),
            scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
            textOverflowX: el.scrollWidth > el.clientWidth + 1,
            clippedBy: clippersOf(el).filter((c) => b.left < c.left - 1 || b.right > c.right + 1)};
  };
  const doc = document.documentElement;
  const section = [...document.querySelectorAll('section')]
    .find((s) => /学习目标|Learning goals/.test(s.querySelector('h4')?.textContent || ''));
  // The editor is the card that owns the slider — not simply the first card,
  // which would measure a collapsed neighbour in a multi-goal profile.
  const editor = section
    ? [...section.querySelectorAll('.rounded-xl')].find((c) => c.querySelector('input[type=range]'))
    : null;
  return {
    document: {scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
               overflowsHorizontally: doc.scrollWidth > doc.clientWidth + 1},
    goalSection: describe(section),
    goalSectionOverflows: section ? section.scrollWidth > section.clientWidth + 1 : null,
    editorCard: describe(editor),
    editor: editor ? {
      titleInput: describe(editor.querySelector('input:not([type=range])')),
      slider: describe(editor.querySelector('input[type=range]')),
      textarea: describe(editor.querySelector('textarea')),
      endpointButton: describe([...editor.querySelectorAll('button')]
        .find((b) => /^将优先级设为|^Set priority to/.test((b.textContent || '').trim())) || null),
    } : null,
  };
}"""


def measure_editor(page: Page) -> dict:
    return page.evaluate(R2_PROBE)


# ---------------------------------------------------------------------------
# Fixtures and server simulation
# ---------------------------------------------------------------------------

def goal_record(holder: dict, goal_id: str) -> dict:
    return next(g for g in holder["profile"]["goals"] if g["goal_id"] == goal_id)


def snapshot_goal(holder: dict, goal_id: str) -> dict:
    return json.loads(json.dumps(goal_record(holder, goal_id)))


def stamps_of(record: dict) -> dict:
    return {k: v for k, v in (record.get("manual") or {}).items()}


def apply_server_update(holder: dict, goal_id: str, fields: dict) -> dict:
    """Change the stored record as another writer would.

    The new stamps are far above anything the client can issue, so "the stamp
    did not move" and "the server's newer stamp survived" are distinguishable.
    """
    record_ = goal_record(holder, goal_id)
    manual = dict(record_.get("manual") or {})
    seq = max(holder.get("goal_edit_seq", 20), 1000)
    record_.update(fields)
    for field in STAMPED_FIELDS:
        if field in fields:
            seq += 1
            manual[field] = {"at_seq": 0, "edit": seq}
    record_["manual"] = manual
    holder["goal_edit_seq"] = seq
    return json.loads(json.dumps(record_))


def refresh(page: Page):
    """Pull the newest record into the store while the editor stays open."""
    page.get_by_role("button", name=re.compile(r"^刷新$|^Refresh$")).click()
    page.wait_for_timeout(700)
    ensure(page.query_selector("input[type=range]") is not None,
           "the editor was unmounted by the refresh")


def open_editor(page: Page, title: str):
    card = r1.goal_card(page, title)
    page.wait_for_timeout(150)
    return r1.open_goal_editor(card)


def save(page: Page, handle):
    r1.save_goal(handle)
    page.wait_for_timeout(700)


def cancel(handle):
    r1.cancel_goal(handle)


def patch_bodies(requests: list[dict], goal_id: str) -> list[dict]:
    return r1.goal_patch_bodies(requests, goal_id)


def change_priority(handle, page: Page, percent: int):
    """Move the slider with real keyboard input (React ignores synthetic sets)."""
    slider = handle.query_selector("input[type=range]")
    ensure(slider is not None, "no priority slider in the editor")
    slider.focus()
    page.keyboard.press("Home")
    for _ in range(percent):
        page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)


def change_status(page: Page, handle, label: str):
    combos = handle.query_selector_all("[role=combobox]")
    ensure(len(combos) >= 2, f"expected two selects in the editor, got {len(combos)}")
    combos[1].click()
    page.wait_for_timeout(200)
    page.get_by_role("option", name=label).click()
    page.wait_for_timeout(200)


def title_input(handle):
    return handle.query_selector("input:not([type=range])")


def save_shot(page: Page, name: str):
    page.screenshot(path=str(R2_DIR / name))


def finish(name: str, *, scenario: str, viewport: str, page: Page, holder: dict,
           goal_id: str, before: dict, server_update: dict | None,
           user_fields: list[str], bodies: list[dict], errors: list[str],
           extra: dict | None = None) -> dict:
    """Assemble one scenario record with every field §6 of the task book asks for."""
    after = snapshot_goal(holder, goal_id)
    data = measure(page)
    data.update({
        "file": name,
        "scenario": scenario,
        "viewport": viewport,
        "theme": "light",
        "lang": "zh-CN",
        "evidenceKind": "simulated API (page.route), browser",
        "goalBefore": before,
        "serverPassiveUpdate": server_update,
        "userEditedFields": user_fields,
        "patchBodies": bodies,
        "patchFields": sorted(bodies[-1].keys()) if bodies else [],
        "patchBody": bodies[-1] if bodies else None,
        "goalAfter": after,
        "manualBefore": stamps_of(before),
        "manualAfter": stamps_of(after),
        "pageErrors": list(errors),
        "editorBounds": measure_editor(page),
    })
    if extra:
        data.update(extra)
    return data


# ---------------------------------------------------------------------------
# R2-B01 … R2-B07
# ---------------------------------------------------------------------------

def b01_status_then_priority(browser, out):
    """R2-B01: the server pauses the goal; the user only moves the priority."""
    page, errors, holder, requests = r1.open_page(
        browser, width=1440, height=900, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before = snapshot_goal(holder, "g_normal")
    handle = open_editor(page, "读完 CET4")
    server_record = apply_server_update(holder, "g_normal", {"status": "paused"})
    refresh(page)
    change_priority(handle, page, 40)
    save(page, handle)

    bodies = patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 1, f"B01: expected one PATCH, got {len(bodies)}")
    body = bodies[0]
    ensure(body == {"priority": 0.4},
           f"B01: the body must be exactly {{'priority': 0.4}}, got {body!r}")
    after = goal_record(holder, "g_normal")
    ensure(after["status"] == "paused",
           f"B01: the server's paused status was overwritten ({after['status']!r})")
    ensure(after["priority"] == 0.4, f"B01: priority stored as {after['priority']!r}")
    ensure(after["manual"]["status"] == server_record["manual"]["status"],
           f"B01: manual.status was re-stamped {after['manual'].get('status')!r}")
    ensure(after["manual"]["priority"]["edit"] > before["manual"]["priority"]["edit"],
           "B01: manual.priority did not advance for an explicit change")

    save_shot(page, "r2-b01-status-then-priority.png")
    out.append(finish("r2-b01-status-then-priority.png", scenario="R2-B01",
                      viewport="1440x900", page=page, holder=holder, goal_id="g_normal",
                      before=before, server_update=server_record,
                      user_fields=["priority"], bodies=bodies, errors=errors,
                      extra={"statusStayedPaused": after["status"] == "paused"}))
    ensure(not errors, f"B01: page errors {errors}")
    page.close()


def b02_title_then_status(browser, out):
    """R2-B02: the server renames the goal; the user only changes the status."""
    page, errors, holder, requests = r1.open_page(
        browser, width=1440, height=900, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before = snapshot_goal(holder, "g_normal")
    handle = open_editor(page, "读完 CET4")
    server_record = apply_server_update(holder, "g_normal", {"title": "读完 CET4 阅读真题（服务端）"})
    refresh(page)
    change_status(page, handle, "已暂停")
    save(page, handle)

    bodies = patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 1, f"B02: expected one PATCH, got {len(bodies)}")
    body = bodies[0]
    ensure(body == {"status": "paused"}, f"B02: expected exactly status, got {body!r}")
    after = goal_record(holder, "g_normal")
    ensure(after["title"] == "读完 CET4 阅读真题（服务端）",
           f"B02: the newer title was overwritten ({after['title']!r})")
    ensure(after["manual"]["title"] == server_record["manual"]["title"],
           f"B02: manual.title was re-stamped {after['manual'].get('title')!r}")

    save_shot(page, "r2-b02-title-then-status.png")
    out.append(finish("r2-b02-title-then-status.png", scenario="R2-B02",
                      viewport="1440x900", page=page, holder=holder, goal_id="g_normal",
                      before=before, server_update=server_record,
                      user_fields=["status"], bodies=bodies, errors=errors))
    ensure(not errors, f"B02: page errors {errors}")
    page.close()


def b03_type_criteria_then_title(browser, out):
    """R2-B03: the server changes type and criteria; the user only edits the title."""
    page, errors, holder, requests = r1.open_page(
        browser, width=1440, height=900, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before = snapshot_goal(holder, "g_normal")
    handle = open_editor(page, "读完 CET4")
    server_record = apply_server_update(
        holder, "g_normal",
        {"type": "exam", "success_criteria": ["服务端新标准", "另一条标准"]})
    refresh(page)
    title_input(handle).fill("编辑期间改的标题")
    page.wait_for_timeout(150)
    save(page, handle)

    bodies = patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 1, f"B03: expected one PATCH, got {len(bodies)}")
    body = bodies[0]
    ensure(body == {"title": "编辑期间改的标题"},
           f"B03: expected exactly the title, got {body!r}")
    after = goal_record(holder, "g_normal")
    ensure(after["type"] == "exam", f"B03: type reverted to {after['type']!r}")
    ensure(after["success_criteria"] == ["服务端新标准", "另一条标准"],
           f"B03: the newer criteria were overwritten ({after['success_criteria']!r})")

    page.wait_for_timeout(200)
    save_shot(page, "r2-b03-type-criteria-then-title.png")
    out.append(finish("r2-b03-type-criteria-then-title.png", scenario="R2-B03",
                      viewport="1440x900", page=page, holder=holder, goal_id="g_normal",
                      before=before, server_update=server_record,
                      user_fields=["title"], bodies=bodies, errors=errors))
    ensure(not errors, f"B03: page errors {errors}")
    page.close()


def b04_multi_update_no_edit(browser, out):
    """R2-B04: every editable field changes on the server; the user saves nothing."""
    page, errors, holder, requests = r1.open_page(
        browser, width=1440, height=900, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before = snapshot_goal(holder, "g_normal")
    handle = open_editor(page, "读完 CET4")
    server_record = apply_server_update(holder, "g_normal", {
        "title": "读完 CET4 阅读真题（服务端）",
        "type": "exam",
        "status": "paused",
        "priority": 0.8,
        "success_criteria": ["服务端新标准"],
    })
    refresh(page)
    save(page, handle)

    bodies = patch_bodies(requests, "g_normal")
    ensure(not bodies,
           f"B04: saving an untouched editor issued {len(bodies)} request(s): {bodies!r}")
    after = goal_record(holder, "g_normal")
    ensure(after == server_record,
           f"B04: the stored record changed\n  before={server_record!r}\n  after={after!r}")
    ensure(page.query_selector("input[type=range]") is None,
           "B04: the editor stayed open after a no-op save")

    save_shot(page, "r2-b04-multi-update-no-edit.png")
    out.append(finish("r2-b04-multi-update-no-edit.png", scenario="R2-B04",
                      viewport="1440x900", page=page, holder=holder, goal_id="g_normal",
                      before=before, server_update=server_record,
                      user_fields=[], bodies=bodies, errors=errors,
                      extra={"patchCount": 0}))
    ensure(not errors, f"B04: page errors {errors}")
    page.close()


def b05_refresh_cancel_reopen(browser, out):
    """R2-B05: passive refresh → cancel → reopen → save only the status."""
    page, errors, holder, requests = r1.open_page(
        browser, width=1440, height=900, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before = snapshot_goal(holder, "g_normal")
    handle = open_editor(page, "读完 CET4")
    server_record = apply_server_update(holder, "g_normal", {"title": "读完 CET4 阅读真题（服务端）"})
    refresh(page)
    title_input(handle).fill("临时改的标题")
    page.wait_for_timeout(150)
    cancel(handle)
    page.wait_for_timeout(500)

    ensure(not patch_bodies(requests, "g_normal"), "B05: cancel issued a PATCH")
    card_text = r1.goal_card(page, "读完 CET4 阅读真题（服务端）").inner_text()
    ensure("临时改的标题" not in card_text, f"B05: the discarded draft survived: {card_text!r}")

    handle = open_editor(page, "读完 CET4 阅读真题（服务端）")
    reopened_title = title_input(handle).input_value()
    ensure(reopened_title == "读完 CET4 阅读真题（服务端）",
           f"B05: the reopened editor started from {reopened_title!r}")
    change_status(page, handle, "已完成")
    save(page, handle)

    bodies = patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 1, f"B05: expected one PATCH, got {len(bodies)}")
    ensure(bodies[0] == {"status": "completed"},
           f"B05: expected exactly status, got {bodies[0]!r}")
    after = goal_record(holder, "g_normal")
    ensure(after["title"] == "读完 CET4 阅读真题（服务端）",
           f"B05: the newer title was overwritten ({after['title']!r})")

    save_shot(page, "r2-b05-refresh-cancel-reopen.png")
    out.append(finish("r2-b05-refresh-cancel-reopen.png", scenario="R2-B05",
                      viewport="1440x900", page=page, holder=holder, goal_id="g_normal",
                      before=before, server_update=server_record,
                      user_fields=["status"], bodies=bodies, errors=errors,
                      extra={"reopenedTitle": reopened_title,
                             "cancelledDraftDiscarded": "临时改的标题" not in card_text}))
    ensure(not errors, f"B05: page errors {errors}")
    page.close()


def b06_failure_refresh_retry(browser, out):
    """R2-B06: save fails → server updates → retry sends only the user's field."""
    page, errors, holder, requests = r1.open_page(
        browser, width=1440, height=900, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(200)

    before = snapshot_goal(holder, "g_normal")
    handle = open_editor(page, "读完 CET4")
    change_status(page, handle, "已暂停")
    holder["goal_fail"] = True
    save(page, handle)

    handle_text = handle.inner_text() or ""
    ensure("服务端暂时不可用" in handle_text,
           f"B06: no failure message; card reads {handle_text!r}")
    ensure(page.query_selector("input[type=range]") is not None,
           "B06: the editor closed after a failed save")

    server_record = apply_server_update(holder, "g_normal", {"title": "读完 CET4 阅读真题（服务端）"})
    refresh(page)
    holder["goal_fail"] = False
    save(page, handle)

    bodies = patch_bodies(requests, "g_normal")
    ensure(len(bodies) == 2, f"B06: expected two attempts, got {len(bodies)}")
    ensure(bodies[0] == {"status": "paused"},
           f"B06: the failed attempt sent {bodies[0]!r}")
    ensure(bodies[1] == {"status": "paused"},
           f"B06: the retry must send only the status, got {bodies[1]!r}")
    after = goal_record(holder, "g_normal")
    ensure(after["title"] == "读完 CET4 阅读真题（服务端）",
           f"B06: the retry overwrote the newer title ({after['title']!r})")
    ensure(after["status"] == "paused", f"B06: status stored as {after['status']!r}")

    save_shot(page, "r2-b06-failure-refresh-retry.png")
    out.append(finish("r2-b06-failure-refresh-retry.png", scenario="R2-B06",
                      viewport="1440x900", page=page, holder=holder, goal_id="g_normal",
                      before=before, server_update=server_record,
                      user_fields=["status"], bodies=bodies, errors=errors,
                      extra={"attemptBodies": bodies,
                             "failureMessage": next((line.strip() for line in handle_text.splitlines()
                                                     if "服务端暂时不可用" in line), "")}))
    ensure(not errors, f"B06: page errors {errors}")
    page.close()


def b07_320_anomaly_endpoint(browser, out):
    """R2-B07: 320px — anomalous priority, endpoint confirmation, with a passive update."""
    page, errors, holder, requests = r1.open_page(
        browser, width=320, height=640, profile_payload=PROFILE_ZH)
    goal_section(page).scroll_into_view_if_needed()
    page.wait_for_timeout(250)

    before = snapshot_goal(holder, "g_anomaly")
    handle = open_editor(page, "背完核心词表")
    server_record = apply_server_update(holder, "g_anomaly", {"status": "paused"})
    refresh(page)

    buttons = r1.editor_buttons(handle)
    endpoint = next((b for text, b in buttons.items() if text.startswith("将优先级设为 100%")), None)
    ensure(endpoint is not None, f"B07: no endpoint button, have {list(buttons)}")
    # Measure *with* the endpoint button on screen: it only exists while the
    # stored value is anomalous, and the assertion is about its 320px box.
    bounds = measure_editor(page)
    ensure(not bounds["document"]["overflowsHorizontally"], "B07: the page overflows horizontally")
    ensure(not bounds["goalSectionOverflows"], "B07: the goal section overflows horizontally")
    for part in ("titleInput", "slider", "textarea", "endpointButton"):
        box = (bounds["editor"] or {}).get(part)
        ensure(box is not None, f"B07: no box for {part}")
        ensure(not box["clippedBy"], f"B07: {part} is clipped {box['clippedBy']}")
    card = bounds["editorCard"]
    ensure(card and card["right"] <= 320 and card["left"] >= -1,
           f"B07: the editor escapes the viewport: {card!r}")

    endpoint.click()
    page.wait_for_timeout(250)
    ensure(not measure_editor(page)["document"]["overflowsHorizontally"],
           "B07: confirming the endpoint introduced horizontal overflow")

    # Evidence of the confirmation itself: the endpoint button disappears once
    # the value becomes a percentage, so this must be captured before saving.
    save_shot(page, "r2-b07a-320-endpoint-confirm.png")

    save(page, handle)
    bodies = patch_bodies(requests, "g_anomaly")
    ensure(len(bodies) == 1, f"B07: expected one PATCH, got {len(bodies)}")
    ensure(bodies[0] == {"priority": 1},
           f"B07: expected exactly the endpoint value, got {bodies[0]!r}")
    after = goal_record(holder, "g_anomaly")
    ensure(after["priority"] == 1, f"B07: priority stored as {after['priority']!r}")
    ensure(after["status"] == "paused",
           f"B07: the server's paused status was overwritten ({after['status']!r})")

    page.wait_for_timeout(200)
    save_shot(page, "r2-b07-320-anomaly-endpoint.png")
    out.append(finish("r2-b07-320-anomaly-endpoint.png", scenario="R2-B07",
                      viewport="320x640", page=page, holder=holder, goal_id="g_anomaly",
                      before=before, server_update=server_record,
                      user_fields=["priority"], bodies=bodies, errors=errors,
                      extra={"endpointLabel": "将优先级设为 100%",
                             "editorBoundsWhileOpen": bounds,
                             "editorBoundsChecked": ["titleInput", "slider", "textarea",
                                                     "endpointButton", "editorCard"]}))
    ensure(not errors, f"B07: page errors {errors}")
    page.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    R2_DIR.mkdir(parents=True, exist_ok=True)
    R2_RERUN_DIR.mkdir(parents=True, exist_ok=True)

    # Re-run the R1 scenarios from their own module, but send every artefact to
    # the R2 folder: the original P2-6 and R1 evidence must stay reproducible.
    r1.R1_DIR = R2_RERUN_DIR
    p26.ASSETS = R2_RERUN_DIR

    out: list[dict] = []
    rerun: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            b01_status_then_priority(browser, out)
            b02_title_then_status(browser, out)
            b03_type_criteria_then_title(browser, out)
            b04_multi_update_no_edit(browser, out)
            b05_refresh_cancel_reopen(browser, out)
            b06_failure_refresh_retry(browser, out)
            b07_320_anomaly_endpoint(browser, out)

            r01 = []
            r1.r01_title_only_anomaly(browser, r01)
            r1.r02_status_only_normal(browser, r01)
            r1.r03_active_change(browser, r01)
            r1.r04_passive_update(browser, r01)
            r1.r05_cancel_and_failure(browser, r01)
            r1.r06_course_notes_320(browser, r01)
            r1.r07_english_320(browser, r01)
            r1.r08_bad_evidence_arrays(browser, r01)

            b = []
            p26.b01_1440_all_courses(browser, b)
            p26.b02_390_stacked(browser, b)
            r1.b03_unknown_source_r1(browser, b)
            p26.b04_320_english(browser, b)
            p26.b05_dark(browser, b)
            p26.b06_manual_save_success(browser, b)
            p26.b07_save_failure(browser, b)
            p26.b08_legacy_mirror(browser, b)
            b09 = []
            r1.b09_goal_priority_r1(browser, b09)
            p26.b10_course_320(browser, b)

            rerun.extend(r01)
            rerun.extend(b)
            rerun.extend(b09)

            METRICS.write_text(json.dumps({
                "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
                "base": BASE,
                "evidenceKinds": {
                    "r2Scenarios": "simulated API (page.route) + real browser",
                    "r1Rerun": "same fixtures as qa_p2_6_r1.py, artefact dir redirected",
                    "realRoute": ("applications-side contract proven by "
                                  "apps/learning-agent/src/server/routes/"
                                  "learner.goal-priority.test.ts (Vitest, real handler)"),
                },
                "note": ("E4.9i-P2-6-R2. R2-B01..B07 change the server's record while the "
                         "goal editor is open and assert the full PATCH body. The 19 R1 "
                         "scenarios are re-run from qa_p2_6_r1.py itself into r2/r1-rerun/; "
                         "P2-6-assets/p26-*.png and r1/ are untouched."),
                "scenarios": out,
                "r1Rerun": rerun,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(out)} R2 scenarios + {len(rerun)} R1 rerun entries -> {METRICS}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
