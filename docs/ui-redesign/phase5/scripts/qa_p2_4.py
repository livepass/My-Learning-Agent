"""E4.9i-P2-4 browser acceptance: the six knowledge-state filters.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_4.py

Every /api request is answered by `page.route` from fixtures in this file, so no
real learner data is read or written and no backend is needed. Screenshots and
metrics go to `P2-4-assets/`; the P2-3 and P2-3-R1 evidence is not touched.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "http://127.0.0.1:5193/?page=profile"
API_ROUTE = re.compile(r"^http://127\.0\.0\.1:5193/api/")
PHASE = Path(__file__).resolve().parents[1]
ASSETS = PHASE / "P2-4-assets"
METRICS = ASSETS / "p24-browser-metrics.json"
# E4.9i-P2-4-R1 keeps its own file so the P2-4 record stays intact.
R1_METRICS = ASSETS / "r1-browser-metrics.json"
# E4.9i-P2-4-R2 likewise: the R1 evidence is never overwritten.
R2_METRICS = ASSETS / "r2-browser-metrics.json"

TODAY = "2026-11-24T08:00:00.000Z"
VIEWPORTS = {
    "desktop": (1440, 900),
    "medium": (1024, 768),
    "tablet": (768, 1024),
    "mobile": (390, 844),
    "narrow": (320, 640),
}

# The six filters, in the order the component renders them.
FILTER_LABELS = ["全部", "需要关注", "待复习", "存在误区", "稳定", "证据不足"]
FILTER_LABELS_EN = ["All", "Needs attention", "Review due", "Misconception", "Stable", "Insufficient evidence"]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def state(concept_id, name, label, *, domain="cet4", mastery=0.5, next_actions=None,
          diagnosis="诊断文本。", due=None, evidence=None):
    return {
        "concept_id": concept_id,
        "concept_name": name,
        "domain": domain,
        "state_label": label,
        "mastery": mastery,
        "confidence": 0.5,
        "stability": 0.5,
        "evidence_ids": evidence or ["e1"],
        "diagnosis": diagnosis,
        "next_actions": next_actions or [],
        "review_due_at": due,
    }


def profile(states, *, misconceptions=None, summary="以 CET4 阅读为主线：先补同义替换。", goals=None):
    return {
        "learner_id": "default",
        "version": 7,
        "updated_at": TODAY,
        "goals": goals if goals is not None else [
            {"goal_id": "g1", "title": "掌握 CET4 阅读", "type": "skill", "priority": 0.7,
             "status": "active", "success_criteria": ["每周 3 次练习"], "source": "user_declared",
             "updated_at": TODAY},
        ],
        "knowledge_states": states,
        "misconceptions": misconceptions or [],
        "preferences": {"explanation_style": ["示例优先"], "practice_style": ["小步练习"],
                        "feedback_tone": ["直接"], "avoid": ["长篇讲解"]},
        "profile_summary": summary,
    }


# Two of each weak label, plus one of every non-weak label, so every filter has
# a distinct, checkable count.
MIXED = profile([
    state("c_learn1", "虚拟语气", "learning", next_actions=["先做一次无提示提取。"]),
    state("c_learn2", "定语从句", "learning"),
    state("c_fragile1", "段落主旨", "fragile"),
    state("c_fragile2", "推理题定位", "fragile"),
    state("c_review1", "连接词逻辑", "review_due"),
    state("c_review2", "同义替换", "review_due", due="2026-12-01T00:00:00.000Z"),
    state("c_misc1", "近义词辨析", "misconception"),
    state("c_stable1", "细节匹配", "stable"),
    state("c_stable2", "语义推断", "stable"),
    state("c_stable3", "语法填空", "stable"),
    state("c_unknown1", "长难句拆分", "unknown"),
    state("c_missing1", "未标注状态", None),
])

# Only stable states: every other filter is empty, which must stay selectable.
ALL_STABLE = profile([
    state("c_s1", "同义替换", "stable"),
    state("c_s2", "虚拟语气", "stable"),
])

# One concept, weak, so a stable filter has no match.
ONE_LEARNING = profile([state("c_l1", "虚拟语气", "learning")])

COURSE_A = {
    "course": {"course_id": "course_a", "title": "同义替换", "description": "",
               "status": "in_progress", "created_at": TODAY, "updated_at": TODAY},
    "goals": [],
    "knowledge_states": [
        {**state("a1", "课程A学习中", "learning"), "evidence_ids": ["a", "b"]},
        {**state("a2", "课程A稳定", "stable"), "evidence_ids": ["c"]},
        {**state("a3", "课程A待复习", "review_due"), "evidence_ids": ["d"]},
    ],
    "preferences": {"explanation_style": [], "practice_style": [], "feedback_tone": [], "avoid": []},
    "unclassified": {"knowledge_states": 0, "goals": 0},
}
COURSE_B = {
    **COURSE_A,
    "course": {**COURSE_A["course"], "course_id": "course_b", "title": "高等数学"},
    "knowledge_states": [{**state("b1", "课程B稳定", "stable"), "evidence_ids": ["e"]}],
}
COURSE_LIST = {"courses": [
    {"course_id": "course_a", "title": "同义替换", "description": "", "status": "in_progress",
     "created_at": TODAY, "updated_at": TODAY,
     "counts": {"goals": 0, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0}},
    {"course_id": "course_b", "title": "高等数学", "description": "", "status": "in_progress",
     "created_at": TODAY, "updated_at": TODAY,
     "counts": {"goals": 0, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0}},
]}


# ---------------------------------------------------------------------------
# Page plumbing
# ---------------------------------------------------------------------------

def install_routes(page: Page, *, profile_payload, courses=None, patch_delay_ms=0, fail_patch=False,
                   live=None):
    """Answer every API call from fixtures; record requests for assertions.

    `live` is an optional mutable dict; when given, GET /api/learner/profile
    returns `live["profile"]`, which lets a scenario change what the "server"
    holds between reads (a passive refresh) without restarting the page.
    """
    calls: list[str] = []
    holder = live if live is not None else {"profile": profile_payload}

    def handler(route, request):
        path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
        calls.append(f"{request.method} {path}")
        if path == "/api/learner/profile" and request.method == "GET":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["profile"]))
        if path == "/api/learner/profile" and request.method == "PATCH":
            if fail_patch:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "PATCH_FAILED"}))
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["profile"]))
        if path.startswith("/api/learner/profile/knowledge/"):
            concept_id = path.rsplit("/", 1)[-1]
            if fail_patch:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "PATCH_FAILED"}))
            # The all-courses list re-reads after a save; return the record with
            # the new diagnosis so the test can see the save land.
            body = json.loads(request.post_data or "{}")
            updated = next((s for s in holder["profile"]["knowledge_states"]
                            if s["concept_id"] == concept_id), state(concept_id, concept_id, "learning"))
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({**updated, **body}))
        if path == "/api/courses":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(courses or {"courses": []}))
        if path == "/api/courses/course_a/learner":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(COURSE_A))
        if path == "/api/courses/course_b/learner":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(COURSE_B))
        if path == "/api/courses/daily":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"date": "2026-11-24", "daily_minutes": 30,
                                                  "courses": [], "notes": []}))
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

    page.route(API_ROUTE, handler)
    return calls


def set_prefs(page: Page, *, theme="light", lang="zh-CN"):
    page.add_init_script(
        f"localStorage.setItem('inno.theme', {json.dumps(theme)});"
        f"localStorage.setItem('inno.locale', {json.dumps(lang)});"
    )


def open_page(browser, *, width, height, profile_payload, theme="light", lang="zh-CN",
              courses=None, patch_delay_ms=0, fail_patch=False, live=None):
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    set_prefs(page, theme=theme, lang=lang)
    calls = install_routes(page, profile_payload=profile_payload, courses=courses,
                           patch_delay_ms=patch_delay_ms, fail_patch=fail_patch, live=live)
    page.goto(BASE, wait_until="networkidle")
    page.locator(".mla-profile-container").wait_for(state="visible", timeout=15000)
    expand_knowledge(page)
    return page, errors, calls


def expand_knowledge(page: Page):
    """Open the 知识状态 section; above five rows it starts collapsed.

    The course-scoped view has no such section, so a missing header is fine.
    """
    header = page.get_by_role("button", name=re.compile(r"^知识状态|^Knowledge"))
    if header.count() == 0:
        return
    if header.first.get_attribute("aria-expanded") == "false":
        header.first.click()
        page.wait_for_timeout(250)


def open_dirty_editor(page: Page, concept_name: str, text: str):
    """Open one knowledge row, press 编辑 and type into its diagnosis.

    Scoped to the 知识状态 section: the page also has goal and misconception
    edit buttons and textareas, and a global locator would hit those instead.
    """
    section = page.locator("section", has=page.get_by_role("button", name=re.compile(r"^知识状态")))
    row = section.locator("button[aria-expanded]", has_text=concept_name).first
    row.click()
    page.wait_for_timeout(120)
    section.get_by_role("button", name="编辑").first.click()
    page.wait_for_timeout(120)
    section.locator("textarea").first.fill(text)
    page.wait_for_timeout(120)


def knowledge_section(page: Page):
    # Language-aware: the R1 English scenario uses the same helper.
    return page.locator("section", has=page.get_by_role("button", name=re.compile(r"^知识状态|^Knowledge")))


def reset_scroll(page: Page):
    page.evaluate("""() => {
      const scroller = document.querySelector('.mla-profile-container')?.parentElement;
      if (scroller) scroller.scrollTop = 0;
      window.scrollTo(0, 0);
    }""")


def scroll_to_section(page: Page, needle: str):
    page.evaluate("""(needle) => {
      const section = [...document.querySelectorAll('section')]
        .find((s) => (s.querySelector('h4')?.textContent || '').includes(needle));
      const container = document.querySelector('.mla-profile-container');
      const scroller = container ? container.parentElement : null;
      if (!section || !scroller) return;
      const offset = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        + scroller.scrollTop - 12;
      scroller.scrollTop = Math.max(0, offset);
    }""", needle)
    page.wait_for_timeout(150)


def shoot(page: Page, filename: str):
    """Full-page shot: grow the viewport to the panel's content height.

    The shell locks the document to the viewport and the panel scrolls inside
    it, so `full_page=True` alone would capture only the first screen.
    """
    reset_scroll(page)
    viewport = page.viewport_size
    heights = page.evaluate("""() => {
      const container = document.querySelector('.mla-profile-container');
      const scroller = container ? container.parentElement : null;
      return scroller ? { content: scroller.scrollHeight, visible: scroller.clientHeight } : null;
    }""")
    extra = max(0, heights["content"] - heights["visible"]) if heights else 0
    page.set_viewport_size({"width": viewport["width"], "height": viewport["height"] + extra + 40})
    page.wait_for_timeout(150)
    reset_scroll(page)
    page.screenshot(path=str(ASSETS / filename), full_page=True)
    page.set_viewport_size(viewport)
    page.wait_for_timeout(80)


def collect(page: Page) -> dict:
    """Everything the metrics file records, read structurally (no test ids)."""
    return page.evaluate("""() => {
      const txt = (node) => (node ? node.textContent.trim() : null);
      const sectionByHeading = (needle) => [...document.querySelectorAll('section')]
        .find((s) => (s.querySelector('h4')?.textContent || '').includes(needle)) || null;
      const knowledge = sectionByHeading('知识状态') || sectionByHeading('Knowledge');

      const chips = knowledge ? [...knowledge.querySelectorAll('button[aria-pressed]')].map((b) => ({
        label: txt(b.firstElementChild),
        count: txt(b.lastElementChild),
        pressed: b.getAttribute('aria-pressed') === 'true',
        width: Math.round(b.getBoundingClientRect().width),
        height: Math.round(b.getBoundingClientRect().height),
        // A chip must not be clipped: its content fits inside its own box.
        clipped: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1,
      })) : [];

      // Row headers only: the section's own collapse toggle also carries
      // aria-expanded, so it is excluded.
      const sectionToggle = knowledge ? knowledge.querySelector('h4')?.closest('button') : null;
      const rows = knowledge ? [...knowledge.querySelectorAll('button[aria-expanded]')]
        .filter((b) => b !== sectionToggle)
        .map((b) => {
          const name = b.querySelector('div > div');
          return txt(name) || (txt(b) || '').split('cet4')[0].trim();
        }) : [];

      const filterEmpty = knowledge
        ? [...knowledge.querySelectorAll('p')].map(txt).find((p) => p && (p.includes('当前筛选下没有知识点') || p.includes('No concepts match this filter')))
        : null;

      const doc = document.documentElement;
      const body = document.body;
      const overflowIn = (root) => root ? [...root.querySelectorAll('*')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible')
        .slice(0, 6)
        .map((el) => ({ tag: el.tagName, cls: el.className.toString().slice(0, 50),
                        scrollW: el.scrollWidth, clientW: el.clientWidth })) : [];

      // R1: a protected row is marked by its notice; it is not a filter result.
      const protectedRows = knowledge
        ? [...knowledge.querySelectorAll('p[role="status"]')].length
        : 0;
      const missingRows = knowledge
        ? [...knowledge.querySelectorAll('p[role="status"]')]
            .filter((p) => /不在最新档案|no longer in the latest profile/.test(p.textContent)).length
        : 0;
      const rowIds = rows.map((r) => r);
      const duplicateConceptIds = rowIds.filter((x, i) => rowIds.indexOf(x) !== i);

      // R2: the save control and the "no longer in the profile" notice, read
      // structurally so a disabled button and a live one are distinguishable.
      // Matches the in-flight label too, so `saveDisabled` is a real boolean
      // while a save is pending rather than null from a missed lookup.
      const saveBtn = knowledge
        ? [...knowledge.querySelectorAll('button')]
            .find((b) => /^(保存|保存中|Save|Saving)/.test((b.textContent || '').trim())) || null
        : null;
      const missingNotice = knowledge
        ? [...knowledge.querySelectorAll('p')]
            .map(txt)
            .find((p) => p && (p.includes('不在最新档案') || p.includes('no longer in the latest profile'))) || null
        : null;

      return {
        chips,
        pressedCount: chips.filter((c) => c.pressed).length,
        protectedEditorCount: protectedRows,
        missingConceptCount: missingRows,
        duplicateConceptIds,
        selectedFilter: (chips.find((c) => c.pressed) || {}).label || null,
        filterCounts: Object.fromEntries(chips.map((c) => [c.label, c.count])),
        visibleRows: rows,
        visibleRowCount: rows.length,
        filterEmpty,
        saveDisabled: saveBtn ? saveBtn.disabled : null,
        saveControlPresent: Boolean(saveBtn),
        missingNotice,
        missingFromProfile: Boolean(missingNotice),
        // The filter row is what P2-4 owns; row overflow is the known P2-5
        // fixed-column issue and is recorded separately, never as a P2-4 pass.
        filterOverflow: overflowIn(knowledge ? knowledge.querySelector('[role="group"]') : null),
        rowOverflow: overflowIn(knowledge).filter((o) =>
          !o.cls.includes('rounded-full') && !o.cls.includes('flex-wrap')),
        documentOverflow: doc.scrollWidth > doc.clientWidth,
        bodyOverflow: body.scrollWidth > body.clientWidth,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(txt),
        sliders: document.querySelectorAll('input[type="range"]').length,
        textareas: [...document.querySelectorAll('textarea')].map((t) => t.value),
        lang: document.documentElement.lang,
      };
    }""")


def ensure(condition, message):
    if not condition:
        raise AssertionError(message)


def click_filter(page: Page, label: str):
    page.get_by_role("button", name=re.compile(rf"^{label}")).first.click()
    page.wait_for_timeout(120)


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    measurements = []

    def record(page, filename, *, viewport, scenario, extra=None):
        data = collect(page)
        data.update({"file": filename, "viewport": viewport, "scenario": scenario})
        if extra:
            data.update(extra)
        measurements.append(data)
        return data

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            # 1. Default 全部, desktop -----------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            data = record(page, "p24-desktop-all.png", viewport="1440x900", scenario="all")
            shoot(page, "p24-desktop-all.png")
            ensure([c["label"] for c in data["chips"]] == FILTER_LABELS,
                   f"filter order: {[c['label'] for c in data['chips']]}")
            ensure(data["selectedFilter"] == "全部", f"default selection: {data['selectedFilter']}")
            ensure(data["pressedCount"] == 1, f"pressed count: {data['pressedCount']}")
            ensure(data["filterCounts"] == {
                "全部": "12", "需要关注": "7", "待复习": "2", "存在误区": "1", "稳定": "3", "证据不足": "2",
            }, f"counts: {data['filterCounts']}")
            ensure(data["visibleRowCount"] == 12, f"rows: {data['visibleRowCount']}")
            ensure(not data["filterOverflow"], f"filter overflow: {data['filterOverflow']}")
            ensure(not data["documentOverflow"], "document overflow")
            ensure(not errors, f"page errors: {errors}")
            page.close()

            # 2. Each filter in turn -------------------------------------------
            expected = {
                "需要关注": 7, "待复习": 2, "存在误区": 1, "稳定": 3, "证据不足": 2, "全部": 12,
            }
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            shots = {"需要关注": "p24-desktop-needs-attention.png", "待复习": "p24-desktop-review-due.png",
                     "存在误区": "p24-desktop-misconception.png", "稳定": "p24-desktop-stable.png",
                     "证据不足": "p24-desktop-unknown.png"}
            for label, count in expected.items():
                click_filter(page, label)
                d = collect(page)
                ensure(d["selectedFilter"] == label, f"{label}: selection {d['selectedFilter']}")
                ensure(d["pressedCount"] == 1, f"{label}: pressed {d['pressedCount']}")
                ensure(d["visibleRowCount"] == count, f"{label}: rows {d['visibleRowCount']} != {count}")
                # Counts describe the whole list and never change with the filter.
                ensure(d["filterCounts"] == {
                    "全部": "12", "需要关注": "7", "待复习": "2", "存在误区": "1", "稳定": "3", "证据不足": "2",
                }, f"{label}: counts changed -> {d['filterCounts']}")
                if label in shots:
                    record(page, shots[label], viewport="1440x900", scenario=f"filter-{label}")
                    scroll_to_section(page, "知识状态")
                    page.screenshot(path=str(ASSETS / shots[label]), full_page=False)
            ensure(not errors, f"filter walk errors: {errors}")
            page.close()

            # 3. No match: the filter's own message, not an empty profile -------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=ONE_LEARNING)
            click_filter(page, "稳定")
            data = record(page, "p24-desktop-no-match.png", viewport="1440x900", scenario="no-match")
            scroll_to_section(page, "知识状态")
            page.screenshot(path=str(ASSETS / "p24-desktop-no-match.png"), full_page=False)
            ensure(data["visibleRowCount"] == 0, f"no-match rows: {data['visibleRowCount']}")
            ensure(data["filterEmpty"] and "当前筛选下没有知识点" in data["filterEmpty"],
                   f"no-match message: {data['filterEmpty']}")
            # Switching back to 全部 must restore the list.
            click_filter(page, "全部")
            ensure(collect(page)["visibleRowCount"] == 1, "all did not restore the row")
            ensure(not errors, f"no-match errors: {errors}")
            page.close()

            # 4. Zero-count filters stay selectable -----------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=ALL_STABLE)
            click_filter(page, "待复习")
            d = collect(page)
            ensure(d["filterCounts"]["待复习"] == "0", f"zero count: {d['filterCounts']}")
            ensure(d["selectedFilter"] == "待复习", "zero-count filter not selectable")
            ensure(d["visibleRowCount"] == 0, "zero-count filter showed rows")
            page.close()

            # 5. Draft protection: cancel keeps filter, editor and draft --------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            open_dirty_editor(page, "虚拟语气", "未保存的草稿内容")
            dialogs = []
            page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
            click_filter(page, "稳定")
            data = record(page, "p24-desktop-filter-cancel.png", viewport="1440x900", scenario="filter-cancel",
                          extra={"confirmCount": len(dialogs), "draftPreserved": "未保存的草稿内容" in " ".join(data_textareas(page))})
            page.screenshot(path=str(ASSETS / "p24-desktop-filter-cancel.png"), full_page=False)
            ensure(len(dialogs) == 1, f"expected one confirm, got {dialogs}")
            ensure(data["selectedFilter"] == "全部", f"filter changed despite refusal: {data['selectedFilter']}")
            ensure("未保存的草稿内容" in " ".join(data["textareas"]), "draft lost after refusal")
            ensure(data["sliders"] >= 1, "editor closed after refusal")
            page.close()

            # 6. Draft protection: confirm switches and drops the draft --------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            open_dirty_editor(page, "虚拟语气", "确认后应被丢弃")
            accepted = []
            page.on("dialog", lambda d: (accepted.append(d.message), d.accept()))
            click_filter(page, "稳定")
            data = record(page, "p24-desktop-filter-confirm.png", viewport="1440x900", scenario="filter-confirm",
                          extra={"confirmCount": len(accepted)})
            page.screenshot(path=str(ASSETS / "p24-desktop-filter-confirm.png"), full_page=False)
            ensure(len(accepted) == 1, f"expected one confirm, got {accepted}")
            ensure(data["selectedFilter"] == "稳定", f"filter not applied: {data['selectedFilter']}")
            ensure(data["sliders"] == 0, "editor still open after confirmed switch")
            ensure(data["visibleRowCount"] == 3, f"stable rows: {data['visibleRowCount']}")
            page.close()

            # 7. Save in flight blocks the switch, without a dialog -------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            open_dirty_editor(page, "虚拟语气", "保存中")
            # Hold the PATCH open so the save stays in flight.
            page.unroute(API_ROUTE)

            def slow_patch(route, request):
                path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
                if path.startswith("/api/learner/profile/knowledge/"):
                    return  # never fulfils
                if path == "/api/learner/profile":
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps(MIXED))
                return route.fulfill(status=200, content_type="application/json", body=json.dumps({"courses": []}))

            page.route(API_ROUTE, slow_patch)
            knowledge_section(page).get_by_role("button", name="保存").first.click()
            page.wait_for_timeout(200)
            dialogs = []
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            click_filter(page, "稳定")
            data = record(page, "p24-desktop-filter-saving.png", viewport="1440x900", scenario="filter-saving",
                          extra={"confirmCount": len(dialogs), "saveInFlight": True})
            page.screenshot(path=str(ASSETS / "p24-desktop-filter-saving.png"), full_page=False)
            ensure(len(dialogs) == 0, f"a saving switch must not ask: {dialogs}")
            ensure(data["selectedFilter"] == "全部", f"switched while saving: {data['selectedFilter']}")
            ensure(data["sliders"] >= 1, "editor unmounted while saving")
            page.close()

            # 8. Course scope: filter, isolation, reset on switch --------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED,
                                            courses=COURSE_LIST)
            trigger = page.get_by_label("选择学习档案范围")
            trigger.focus()
            page.keyboard.press("Enter")
            page.get_by_role("option", name="同义替换").click()
            page.get_by_role("heading", name="知识掌握").wait_for(state="visible", timeout=15000)
            course_section = page.locator("section", has=page.get_by_role("heading", name="知识掌握"))
            chip = course_section.get_by_role("button", name=re.compile(r"^稳定"))
            chip.click()
            page.wait_for_timeout(120)
            course_state = page.evaluate("""() => {
              const section = [...document.querySelectorAll('section')]
                .find((s) => s.querySelector('h2')?.textContent === '知识掌握');
              const chips = [...section.querySelectorAll('button[aria-pressed]')].map((b) => ({
                label: b.firstElementChild.textContent.trim(),
                count: b.lastElementChild.textContent.trim(),
                pressed: b.getAttribute('aria-pressed') === 'true',
              }));
              return {
                chips,
                rows: [...section.querySelectorAll('.mla-state-row strong')].map((n) => n.textContent),
                editButtons: [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '编辑').length,
                sliders: document.querySelectorAll('input[type="range"]').length,
              };
            }""")
            page.screenshot(path=str(ASSETS / "p24-course-filter.png"), full_page=False)
            ensure([c["label"] for c in course_state["chips"]] == FILTER_LABELS,
                   f"course filter order: {course_state['chips']}")
            ensure(course_state["chips"][0]["count"] == "3", f"course 全部 count: {course_state['chips']}")
            ensure(course_state["rows"] == ["课程A稳定"], f"course stable rows: {course_state['rows']}")
            ensure(course_state["editButtons"] == 0 and course_state["sliders"] == 0,
                   "course view must stay read-only")
            measurements.append({"file": "p24-course-filter.png", "viewport": "1440x900",
                                 "scenario": "course-filter", **course_state})

            # Switching course resets the filter to 全部.
            trigger.focus()
            page.keyboard.press("Enter")
            page.get_by_role("option", name="高等数学").click()
            page.get_by_role("heading", name="知识掌握").wait_for(state="visible", timeout=15000)
            page.wait_for_timeout(200)
            reset = page.evaluate("""() => {
              const section = [...document.querySelectorAll('section')]
                .find((s) => s.querySelector('h2')?.textContent === '知识掌握');
              const pressed = [...section.querySelectorAll('button[aria-pressed]')]
                .filter((b) => b.getAttribute('aria-pressed') === 'true')
                .map((b) => b.firstElementChild.textContent.trim());
              return { pressed, rows: [...section.querySelectorAll('.mla-state-row strong')].map((n) => n.textContent) };
            }""")
            page.screenshot(path=str(ASSETS / "p24-course-reset.png"), full_page=False)
            ensure(reset["pressed"] == ["全部"], f"filter not reset after course switch: {reset['pressed']}")
            ensure(reset["rows"] == ["课程B稳定"], f"course B rows: {reset['rows']}")
            measurements.append({"file": "p24-course-reset.png", "viewport": "1440x900",
                                 "scenario": "course-reset", **reset})
            ensure(not errors, f"course errors: {errors}")
            page.close()

            # 9. Viewports -----------------------------------------------------
            for key, filename in (("medium", "p24-1024.png"), ("tablet", "p24-tablet-768.png"),
                                  ("mobile", "p24-mobile-390.png"), ("narrow", "p24-mobile-320.png")):
                width, height = VIEWPORTS[key]
                page, errors, calls = open_page(browser, width=width, height=height, profile_payload=MIXED)
                click_filter(page, "需要关注")
                data = record(page, filename, viewport=f"{width}x{height}", scenario="narrow-needs-attention")
                shoot(page, filename)
                ensure(not data["documentOverflow"], f"{filename}: document overflow")
                ensure(not data["filterOverflow"], f"{filename}: filter overflow {data['filterOverflow']}")
                ensure(not any(c["clipped"] for c in data["chips"]), f"{filename}: clipped chip")
                ensure(data["selectedFilter"] == "需要关注", f"{filename}: selection")
                ensure(not errors, f"{filename}: errors {errors}")
                page.close()

            # 10. Dark theme ---------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, theme="dark")
            click_filter(page, "待复习")
            data = record(page, "p24-desktop-dark.png", viewport="1440x900", scenario="dark")
            shoot(page, "p24-desktop-dark.png")
            ensure(data["selectedFilter"] == "待复习", "dark selection")
            ensure(not data["filterOverflow"], "dark filter overflow")
            page.close()

            # 11. English ------------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, lang="en")
            data = record(page, "p24-desktop-en.png", viewport="1440x900", scenario="english")
            shoot(page, "p24-desktop-en.png")
            ensure([c["label"] for c in data["chips"]] == FILTER_LABELS_EN,
                   f"en filter labels: {[c['label'] for c in data['chips']]}")
            ensure(data["lang"] == "en", f"lang: {data['lang']}")
            ensure(not data["filterOverflow"], f"en filter overflow: {data['filterOverflow']}")
            ensure("全部" not in (data["filterCounts"] or {}), "Chinese leaked into English filters")
            page.close()

            # 12. Keyboard -----------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            # Focus 全部, then Tab to the next chip and activate it with Space.
            page.get_by_role("button", name=re.compile(r"^全部")).focus()
            page.keyboard.press("Tab")
            page.wait_for_timeout(80)
            focused_label = page.evaluate("document.activeElement?.firstElementChild?.textContent?.trim()")
            page.keyboard.press("Space")
            page.wait_for_timeout(150)
            keyboard_state = page.evaluate("""() => {
              const section = [...document.querySelectorAll('section')]
                .find((s) => s.querySelector('h4')?.textContent?.includes('知识状态'));
              const toggle = section.querySelector('h4')?.closest('button');
              return {
                pressed: [...section.querySelectorAll('button[aria-pressed="true"]')]
                  .map((b) => b.firstElementChild.textContent.trim()),
                rows: [...section.querySelectorAll('button[aria-expanded]')].filter((b) => b !== toggle).length,
              };
            }""")
            page.screenshot(path=str(ASSETS / "p24-desktop-keyboard.png"), full_page=False)
            ensure(focused_label == "需要关注", f"Tab did not reach the second chip: {focused_label}")
            ensure(keyboard_state["pressed"] == ["需要关注"],
                   f"Space did not select the focused chip: {keyboard_state}")
            ensure(keyboard_state["rows"] == 7, f"keyboard filter rows: {keyboard_state['rows']}")
            measurements.append({"file": "p24-desktop-keyboard.png", "viewport": "1440x900",
                                 "scenario": "keyboard", "focusedLabel": focused_label, **keyboard_state})
            ensure(not errors, f"keyboard errors: {errors}")
            page.close()

            # ------------------------------------------------------------------
            # E4.9i-P2-4-R1 专项复验
            # ------------------------------------------------------------------
            r1 = []

            def record_r1(page, filename, *, viewport, scenario, extra=None):
                data = collect(page)
                data.update({"file": filename, "viewport": viewport, "scenario": scenario})
                if extra:
                    data.update(extra)
                r1.append(data)
                return data

            def refresh(page: Page):
                """Click 刷新 and wait for the store round-trip to settle."""
                page.get_by_role("button", name=re.compile(r"^刷新|^Refresh")).click()
                page.wait_for_timeout(400)

            def open_editor(page: Page, name: str, text: str):
                """Open one row's editor and type into *its* diagnosis field.

                Scoped to the row wrapper: with two editors open, a section-wide
                `.first` textarea belongs to whichever row rendered first.
                """
                section = knowledge_section(page)
                row = section.locator("button[aria-expanded]", has_text=name).first
                row.click()
                page.wait_for_timeout(120)
                wrapper = row.locator("xpath=..")
                wrapper.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
                page.wait_for_timeout(120)
                wrapper.locator("textarea").first.fill(text)
                page.wait_for_timeout(120)

            # R1-1. A passive refresh moves the concept out of the filter: the
            # draft survives and the row says why it is still here.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "刷新后仍要保留的草稿")
            live["profile"] = profile([
                state("c_learn1", "虚拟语气", "stable", next_actions=["先做一次无提示提取。"]),
                *MIXED["knowledge_states"][1:],
            ])
            refresh(page)
            data = record_r1(page, "r1-refresh-state-changed.png", viewport="1440x900",
                             scenario="refresh-state-changed")
            page.screenshot(path=str(ASSETS / "r1-refresh-state-changed.png"), full_page=False)
            ensure("刷新后仍要保留的草稿" in " ".join(data["textareas"]),
                   f"R1-1 draft lost: {data['textareas']}")
            ensure(data["protectedEditorCount"] == 1, f"R1-1 notice: {data['protectedEditorCount']}")
            ensure(data["selectedFilter"] == "需要关注", "R1-1 filter changed")
            ensure(not errors, f"R1-1 errors: {errors}")
            page.close()

            # R1-2. The same situation, scrolled so the notice is legible.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "受保护行提示")
            live["profile"] = profile([
                state("c_learn1", "虚拟语气", "stable", next_actions=["先做一次无提示提取。"]),
                *MIXED["knowledge_states"][1:],
            ])
            refresh(page)
            scroll_to_section(page, "知识状态")
            data = record_r1(page, "r1-protected-editor.png", viewport="1440x900", scenario="protected-editor")
            page.screenshot(path=str(ASSETS / "r1-protected-editor.png"), full_page=False)
            ensure(data["protectedEditorCount"] == 1, "R1-2 protected notice missing")
            ensure(not data["documentOverflow"], "R1-2 document overflow")
            page.close()

            # R1-3. While the save is in flight the row stays mounted even though
            # the live profile already moved it out of the filter.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "保存中的草稿")
            page.unroute(API_ROUTE)

            def slow_handler(route, request):
                path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
                if path.startswith("/api/learner/profile/knowledge/"):
                    return  # never fulfils: the save stays in flight
                if path == "/api/learner/profile":
                    return route.fulfill(status=200, content_type="application/json",
                                         body=json.dumps(live["profile"]))
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps({"courses": []}))

            page.route(API_ROUTE, slow_handler)
            knowledge_section(page).get_by_role("button", name=re.compile(r"^保存$|^保存中|^Save$|^Saving")).first.click()
            page.wait_for_timeout(250)
            # While the PATCH is still pending, the server moves the concept out
            # of the filter. The row must stay mounted *and* the save must not be
            # interrupted.
            live["profile"] = profile([
                state("c_learn1", "虚拟语气", "stable"),
                *MIXED["knowledge_states"][1:],
            ])
            refresh(page)
            data = record_r1(page, "r1-save-in-flight.png", viewport="1440x900", scenario="save-in-flight",
                             extra={"saving": True})
            ensure(data["protectedEditorCount"] == 1,
                   f"R1-3 saving row should be protected, got {data['protectedEditorCount']}")
            page.screenshot(path=str(ASSETS / "r1-save-in-flight.png"), full_page=False)
            ensure("保存中的草稿" in " ".join(data["textareas"]), "R1-3 draft lost during save")
            ensure(len(data["textareas"]) > 0, "R1-3 editor unmounted during save")
            ensure(not errors, f"R1-3 errors: {errors}")
            page.close()

            # R1-4. A save that lands with a different state removes the row from
            # the filter after the lifecycle ends.
            live = {"profile": profile([state("c_learn1", "虚拟语气", "learning")])}
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=live["profile"], live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "保存成功后应移出")
            # The next profile read (after the save) reports the new state.
            live["profile"] = profile([state("c_learn1", "虚拟语气", "stable", diagnosis="保存成功后应移出")])
            knowledge_section(page).get_by_role("button", name=re.compile(r"^保存$|^Save$")).first.click()
            page.wait_for_timeout(700)
            data = record_r1(page, "r1-save-state-changed.png", viewport="1440x900", scenario="save-state-changed")
            page.screenshot(path=str(ASSETS / "r1-save-state-changed.png"), full_page=False)
            ensure(data["visibleRowCount"] == 0, f"R1-4 row still visible: {data['visibleRowCount']}")
            ensure(data["filterCounts"].get("稳定") == "1" or data["filterCounts"].get("Stable") == "1",
                   f"R1-4 stable count: {data['filterCounts']}")
            ensure(not data["textareas"], "R1-4 editor still open")
            page.close()

            # R1-5. A failed save keeps the draft and the editor.
            live = {"profile": profile([state("c_learn1", "虚拟语气", "learning")])}
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=live["profile"], live=live, fail_patch=True)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "保存失败的草稿")
            knowledge_section(page).get_by_role("button", name=re.compile(r"^保存$|^Save$")).first.click()
            page.wait_for_timeout(600)
            data = record_r1(page, "r1-save-failed.png", viewport="1440x900", scenario="save-failed")
            page.screenshot(path=str(ASSETS / "r1-save-failed.png"), full_page=False)
            ensure("保存失败的草稿" in " ".join(data["textareas"]), "R1-5 draft lost after failure")
            ensure(data["alerts"], "R1-5 no error surfaced")
            page.close()

            # R1-6. An active switch that keeps the concept matching keeps its draft.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=profile([
                                                state("c_learn1", "虚拟语气", "learning"),
                                                state("c_s1", "同义替换", "stable"),
                                            ]))
            open_editor(page, "虚拟语气", "仍匹配的草稿")
            dialogs = []
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            click_filter(page, "需要关注")
            data = record_r1(page, "r1-retained-draft.png", viewport="1440x900", scenario="retained-draft",
                             extra={"confirmCount": len(dialogs)})
            page.screenshot(path=str(ASSETS / "r1-retained-draft.png"), full_page=False)
            ensure(len(dialogs) == 1, f"R1-6 confirms: {dialogs}")
            ensure("仍匹配的草稿" in " ".join(data["textareas"]), "R1-6 matching draft lost")
            ensure(data["selectedFilter"] == "需要关注", "R1-6 filter not applied")
            page.close()

            # R1-7. Two drafts, one matching: the switch keeps the matching one
            # and drops only the hidden one, after a single confirm.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=profile([
                                                state("c_learn1", "虚拟语气", "learning"),
                                                state("c_s1", "同义替换", "stable"),
                                            ]))
            open_editor(page, "虚拟语气", "被隐藏的草稿")
            open_editor(page, "同义替换", "保留的草稿")
            dialogs = []
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            click_filter(page, "稳定")
            data = record_r1(page, "r1-multiple-drafts.png", viewport="1440x900", scenario="multiple-drafts",
                             extra={"confirmCount": len(dialogs)})
            page.screenshot(path=str(ASSETS / "r1-multiple-drafts.png"), full_page=False)
            ensure(len(dialogs) == 1, f"R1-7 confirms: {dialogs}")
            ensure("保留的草稿" in " ".join(data["textareas"]), "R1-7 matching draft lost")
            ensure("被隐藏的草稿" not in " ".join(data["textareas"]), "R1-7 hidden draft should be gone")
            page.close()

            # R1-8. A completely empty profile: no filter row, the profile empty state.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=profile([], summary=""))
            data = record_r1(page, "r1-empty-profile.png", viewport="1440x900", scenario="empty-profile")
            shoot(page, "r1-empty-profile.png")
            ensure(data["chips"] == [], f"R1-8 filter row on an empty profile: {data['chips']}")
            ensure("暂未追踪任何概念" in page.locator("body").inner_text(), "R1-8 empty state missing")
            ensure(not errors, f"R1-8 errors: {errors}")
            page.close()

            # R1-9. Extreme narrow width with a protected row.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=320, height=640, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "极窄屏草稿")
            live["profile"] = profile([
                state("c_learn1", "虚拟语气", "stable", next_actions=["先做一次无提示提取。"]),
                *MIXED["knowledge_states"][1:],
            ])
            refresh(page)
            data = record_r1(page, "r1-mobile-320.png", viewport="320x640", scenario="narrow-protected")
            shoot(page, "r1-mobile-320.png")
            ensure("极窄屏草稿" in " ".join(data["textareas"]), "R1-9 draft lost at 320px")
            ensure(not data["documentOverflow"], "R1-9 document overflow")
            ensure(not data["filterOverflow"], f"R1-9 filter overflow {data['filterOverflow']}")
            ensure(not errors, f"R1-9 errors: {errors}")
            page.close()

            # R1-10. English copy for the protection notice.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED,
                                            live=live, lang="en")
            click_filter(page, "Needs attention")
            open_editor(page, "虚拟语气", "english draft")
            live["profile"] = profile([
                state("c_learn1", "虚拟语气", "stable", next_actions=["先做一次无提示提取。"]),
                *MIXED["knowledge_states"][1:],
            ])
            refresh(page)
            scroll_to_section(page, "Knowledge")
            data = record_r1(page, "r1-desktop-en.png", viewport="1440x900", scenario="english")
            page.screenshot(path=str(ASSETS / "r1-desktop-en.png"), full_page=False)
            ensure("english draft" in " ".join(data["textareas"]), "R1-10 draft lost")
            body = page.locator("body").inner_text()
            ensure("state has changed" in body, "R1-10 English notice missing")
            ensure("该知识点状态已变化" not in body, "R1-10 Chinese leaked")
            page.close()

            R1_METRICS.write_text(json.dumps({
                "runtime": "E4.9i-P2-4-R1 re-verification; controlled fixtures via page.route, no writes",
                "base": BASE,
                "measurements": r1,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(r1)} R1 scenarios -> {R1_METRICS}")

            # ------------------------------------------------------------------
            # E4.9i-P2-4-R2 专项复验：消失知识点不可保存
            # ------------------------------------------------------------------
            r2 = []

            def record_r2(page, filename, *, viewport, scenario, extra=None):
                data = collect(page)
                data.update({"file": filename, "viewport": viewport, "scenario": scenario})
                if extra:
                    data.update(extra)
                r2.append(data)
                return data

            def lose_concept(live):
                """Make the live profile stop containing 虚拟语气 (c_learn1)."""
                live["profile"] = profile([
                    state("c_s1", "同义替换", "stable"),
                    state("c_review1", "连接词逻辑", "review_due"),
                ])

            def patch_calls(calls):
                return [c for c in calls if c.startswith("PATCH /api/learner/profile/knowledge/")]

            # R2-1. The draft survives and the notice says saving is unavailable.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "消失后的草稿")
            lose_concept(live)
            refresh(page)
            scroll_to_section(page, "知识状态")
            data = record_r2(page, "r2-missing-draft.png", viewport="1440x900", scenario="missing-draft",
                             extra={"draftPreserved": "消失后的草稿" in " ".join(data_textareas(page)),
                                    "saveRequestCount": len(patch_calls(calls))})
            page.screenshot(path=str(ASSETS / "r2-missing-draft.png"), full_page=False)
            ensure(data["draftPreserved"], f"R2-1 draft lost: {data['textareas']}")
            ensure(data["missingFromProfile"], "R2-1 missing notice absent")
            ensure(data["protectedEditorCount"] == 1, "R2-1 row not protected")
            ensure(not errors, f"R2-1 errors: {errors}")
            page.close()

            # R2-2. The save control is disabled, and clicking it writes nothing.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "禁用保存的草稿")
            lose_concept(live)
            refresh(page)
            before = len(patch_calls(calls))
            save = knowledge_section(page).get_by_role("button", name=re.compile(r"^保存$|^Save$")).first
            ensure(save.is_disabled(), "R2-2 save control is enabled for a dropped concept")
            # A disabled control cannot be clicked; dispatch the event anyway to
            # prove the entry guard, not just the attribute, refuses the write.
            save.evaluate("(el) => el.click()")
            page.wait_for_timeout(400)
            scroll_to_section(page, "知识状态")
            data = record_r2(page, "r2-missing-save-disabled.png", viewport="1440x900",
                             scenario="missing-save-disabled",
                             extra={"saveRequestCount": len(patch_calls(calls)) - before})
            page.screenshot(path=str(ASSETS / "r2-missing-save-disabled.png"), full_page=False)
            ensure(data["saveDisabled"] is True, f"R2-2 saveDisabled={data['saveDisabled']}")
            ensure(data["saveRequestCount"] == 0, f"R2-2 wrote anyway: {data['saveRequestCount']}")
            ensure("禁用保存的草稿" in " ".join(data["textareas"]), "R2-2 draft lost")
            page.close()

            # R2-3. The concept disappears while the PATCH is in flight.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "在途消失的草稿")
            page.unroute(API_ROUTE)

            def inflight_handler(route, request):
                path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
                # Keep recording: this handler replaces the one install_routes
                # put in place, and the request count is what R2-3 asserts.
                calls.append(f"{request.method} {path}")
                if path.startswith("/api/learner/profile/knowledge/"):
                    return  # never fulfils: the save stays in flight
                if path == "/api/learner/profile":
                    return route.fulfill(status=200, content_type="application/json",
                                         body=json.dumps(live["profile"]))
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps({"courses": []}))

            page.route(API_ROUTE, inflight_handler)
            knowledge_section(page).get_by_role("button", name=re.compile(r"^保存$|^Save$")).first.click()
            page.wait_for_timeout(250)
            lose_concept(live)
            refresh(page)
            scroll_to_section(page, "知识状态")
            data = record_r2(page, "r2-missing-save-in-flight.png", viewport="1440x900",
                             scenario="missing-save-in-flight",
                             extra={"saving": True, "saveRequestCount": len(patch_calls(calls))})
            page.screenshot(path=str(ASSETS / "r2-missing-save-in-flight.png"), full_page=False)
            ensure("在途消失的草稿" in " ".join(data["textareas"]), "R2-3 editor unmounted mid-save")
            ensure(data["saveRequestCount"] == 1, f"R2-3 requests: {data['saveRequestCount']}")
            # The in-flight request is not cancelled by the concept vanishing.
            ensure(data["saveDisabled"] is True, f"R2-3 save control: {data['saveDisabled']}")
            ensure(not errors, f"R2-3 errors: {errors}")
            page.close()

            # R2-4. The concept comes back: saving is allowed again, draft intact.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "恢复后可保存")
            lose_concept(live)
            refresh(page)
            ensure(knowledge_section(page).get_by_role(
                "button", name=re.compile(r"^保存$|^Save$")).first.is_disabled(),
                "R2-4 precondition: save should be disabled")
            live["profile"] = MIXED
            refresh(page)
            save = knowledge_section(page).get_by_role("button", name=re.compile(r"^保存$|^Save$")).first
            enabled = not save.is_disabled()
            before = len(patch_calls(calls))
            if enabled:
                save.click()
                page.wait_for_timeout(600)
            scroll_to_section(page, "知识状态")
            data = record_r2(page, "r2-restored-concept.png", viewport="1440x900", scenario="restored-concept",
                             extra={"saveEnabledAfterRestore": enabled,
                                    "saveRequestCount": len(patch_calls(calls)) - before})
            page.screenshot(path=str(ASSETS / "r2-restored-concept.png"), full_page=False)
            ensure(enabled, "R2-4 save stayed disabled after the concept returned")
            ensure(data["saveRequestCount"] == 1, f"R2-4 writes after restore: {data['saveRequestCount']}")
            ensure(data["missingFromProfile"] is False, "R2-4 missing notice stayed after the concept returned")
            ensure(not errors, f"R2-4 errors: {errors}")
            page.close()

            # R2-5. Narrow width: the notice fits and nothing overflows.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=320, height=640, profile_payload=MIXED, live=live)
            click_filter(page, "需要关注")
            open_editor(page, "虚拟语气", "窄屏消失草稿")
            lose_concept(live)
            refresh(page)
            scroll_to_section(page, "知识状态")
            data = record_r2(page, "r2-mobile-320.png", viewport="320x640", scenario="narrow-missing")
            page.screenshot(path=str(ASSETS / "r2-mobile-320.png"), full_page=False)
            ensure("窄屏消失草稿" in " ".join(data["textareas"]), "R2-5 draft lost at 320px")
            ensure(data["saveDisabled"] is True, "R2-5 save enabled at 320px")
            ensure(not data["documentOverflow"], "R2-5 document overflow")
            ensure(not data["filterOverflow"], f"R2-5 filter overflow {data['filterOverflow']}")
            ensure(not errors, f"R2-5 errors: {errors}")
            page.close()

            # R2-6. English copy states that saving is unavailable.
            live = {"profile": MIXED}
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED,
                                            live=live, lang="en")
            click_filter(page, "Needs attention")
            open_editor(page, "虚拟语气", "english missing draft")
            lose_concept(live)
            refresh(page)
            scroll_to_section(page, "Knowledge")
            data = record_r2(page, "r2-desktop-en.png", viewport="1440x900", scenario="english-missing")
            page.screenshot(path=str(ASSETS / "r2-desktop-en.png"), full_page=False)
            body = page.locator("body").inner_text()
            ensure("english missing draft" in " ".join(data["textareas"]), "R2-6 draft lost")
            ensure("Saving is unavailable" in body, "R2-6 English notice does not say saving is unavailable")
            ensure("暂时无法保存" not in body, "R2-6 Chinese leaked into English")
            ensure(data["saveDisabled"] is True, "R2-6 save enabled in English view")
            ensure(not errors, f"R2-6 errors: {errors}")
            page.close()

            R2_METRICS.write_text(json.dumps({
                "runtime": "E4.9i-P2-4-R2 re-verification; controlled fixtures via page.route, no writes",
                "base": BASE,
                "measurements": r2,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(r2)} R2 scenarios -> {R2_METRICS}")
        finally:
            browser.close()

    METRICS.write_text(json.dumps({
        "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
        "base": BASE,
        "measurements": measurements,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {len(measurements)} scenarios, metrics -> {METRICS}")


def data_textareas(page: Page) -> list[str]:
    return page.evaluate("[...document.querySelectorAll('textarea')].map((t) => t.value)")


if __name__ == "__main__":
    main()
