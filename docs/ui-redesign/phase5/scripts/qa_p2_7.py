"""E4.9i-P2-7 browser acceptance: three-view state semantics, scope isolation,
review-eligibility boundary, editing safety and the responsive matrix.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_7.py

Scope
-----

* **B01–B18** — the P2-7 scenarios: the three profile views (全部课程 /
  指定课程 / 课程详情·学习概况) must render one state vocabulary, the same
  concept id must not leak across scopes, the 待复习 badge must not be read as
  a formal review entitlement, an unsaved knowledge draft must survive a scope
  switch prompt, and the 320/390/dark/en matrix must not regress.
* **R2 rerun** — the 26 scenarios P2-6-R2 passed (7 R2 + 19 R1), executed from
  their own modules so the rounds stay comparable. Their artefacts go to
  `P2-7-assets/regression-r2/`; no earlier evidence is overwritten.

Evidence boundary
-----------------

Every `/api` request is answered by `page.route` fixtures; no backend is needed
and nothing is written. The goal PATCH fixture copies the ownership rule from
`server/routes/learner.ts` (a field is stamped only when the body contains it).

This is **simulated-API browser evidence**. The server rules it exercises —
`reviewable()` in `courses/daily-plan.ts`, the learner route's partial update —
are proven separately by real-handler Vitest files; the report keeps the two
apart and never presents a mocked response as a server integration result.
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
import qa_p2_6_r2 as r2  # noqa: E402

BASE = p26.BASE
ORIGIN = BASE.split("?")[0]
API_ROUTE = p26.API_ROUTE
PHASE = p26.PHASE
ASSETS = PHASE / "P2-7-assets"
SHOTS = ASSETS / "screenshots"
REGRESSION = ASSETS / "regression-r2"
METRICS = ASSETS / "browser-metrics.json"

TODAY = p26.TODAY
ensure = p26.ensure
measure = p26.measure
requests_to = p26.requests_to

ZH = "zh-CN"
EN = "en"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def state(concept_id, name, label, **extra):
    """One server knowledge record. `label` may be omitted for the missing case."""
    record = {
        "concept_id": concept_id,
        "concept_name": name,
        "domain": "cet4",
        "mastery": 0.5,
        "confidence": 0.5,
        "stability": 0.5,
        "evidence_ids": ["e1"],
        "diagnosis": f"{name}的诊断",
        "next_actions": [f"{name}的建议"],
        "origin": "derived",
        "provenance_unknown": False,
    }
    if label is not None:
        record["state_label"] = label
    record.update(extra)
    return record


#: The eight rows every three-view scenario uses. Six real states plus the two
#: degradations (missing label, unrecognised label). Names are stable so the
#: three views can be compared row by row.
STATE_ROWS = [
    state("k_unknown", "未知状态概念", "unknown", mastery=0.2, origin="derived"),
    state("k_learning", "同义替换", "learning", mastery=0.5, origin="manual",
          evidence_ids=["e1", "e2", "e3"]),
    state("k_fragile", "虚拟语气", "fragile", mastery=0.4),
    state("k_review", "连接词逻辑", "review_due", mastery=0.6,
          review_due_at="2026-11-20T00:00:00.000Z"),
    state("k_stable", "长难句拆分", "stable", mastery=0.9),
    state("k_misc", "近义词辨析", "misconception", mastery=0.3),
    state("k_missing", "无标签概念", None, mastery=0.7, origin="manual"),
    state("k_illegal", "非法状态概念", "brand_new_state", mastery=0.8, origin="manual"),
]

EXPECTED_ZH = {
    "k_unknown": ("未知状态概念", "证据不足", "neutral"),
    "k_learning": ("同义替换", "学习中", "accent"),
    "k_fragile": ("虚拟语气", "不稳定", "warning"),
    "k_review": ("连接词逻辑", "待复习", "warning"),
    "k_stable": ("长难句拆分", "稳定", "success"),
    "k_misc": ("近义词辨析", "存在误区", "danger"),
    "k_missing": ("无标签概念", "证据不足", "neutral"),
    "k_illegal": ("非法状态概念", "证据不足", "neutral"),
}

EXPECTED_EN = {
    "k_unknown": ("Unknown concept", "Insufficient evidence", "neutral"),
    "k_learning": ("Synonyms", "Learning", "accent"),
    "k_fragile": ("Subjunctive", "Fragile", "warning"),
    "k_review": ("Connector logic", "Review due", "warning"),
    "k_stable": ("Clause splitting", "Stable", "success"),
    "k_misc": ("Near synonyms", "Misconception", "danger"),
    "k_missing": ("Unlabelled concept", "Insufficient evidence", "neutral"),
    "k_illegal": ("Illegal state concept", "Insufficient evidence", "neutral"),
}


def localised(rows, lang):
    """The same eight records with English names, for the language scenario."""
    names = {
        "k_unknown": "Unknown concept", "k_learning": "Synonyms", "k_fragile": "Subjunctive",
        "k_review": "Connector logic", "k_stable": "Clause splitting",
        "k_misc": "Near synonyms", "k_missing": "Unlabelled concept",
        "k_illegal": "Illegal state concept",
    }
    if lang == ZH:
        return rows
    return [{**row, "concept_name": names[row["concept_id"]],
             "diagnosis": f"{names[row['concept_id']]} diagnosis",
             "next_actions": [f"{names[row['concept_id']]} action"]} for row in rows]


def goal(goal_id, title, priority=0.5, status="active"):
    return {
        "goal_id": goal_id, "title": title, "type": "skill", "status": status,
        "priority": priority, "success_criteria": ["能读懂 90% 的段落"],
        "manual": {"priority": {"at_seq": 0, "edit": 7}},
    }


def profile(rows, *, goals=None, summary="以 CET4 阅读为主线：先补同义替换。"):
    return {
        "learner_id": "default", "version": 7, "updated_at": TODAY,
        "goals": goals or [], "knowledge_states": rows, "misconceptions": [],
        "preferences": {"explanation_style": [], "practice_style": [],
                        "feedback_tone": [], "avoid": []},
        "profile_summary": summary,
    }


def course(course_id, title):
    return {
        "course_id": course_id, "title": title, "description": "",
        "status": "in_progress", "created_at": TODAY, "updated_at": TODAY,
    }


def course_summary(course_id, title):
    """One row of `GET /api/courses` (the list is wrapped in `{courses: [...]}`)."""
    return {
        **course(course_id, title),
        "counts": {"goals": 1, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0},
    }


def learner_view(course_id, title, rows, *, goals=None, unclassified=None):
    return {
        "course": {"course_id": course_id, "title": title, "description": "",
                   "status": "in_progress", "created_at": TODAY, "updated_at": TODAY},
        "goals": goals or [],
        "knowledge_states": rows,
        "preferences": {"explanation_style": [], "practice_style": [],
                        "feedback_tone": [], "avoid": []},
        "unclassified": unclassified or {"knowledge_states": 0, "goals": 0},
    }


def daily_plan(course_id, title):
    return {
        "course": {"course_id": course_id, "title": title},
        "daily_minutes": 30,
        "status": "ok",
        "task_progress": {"total": 4, "completed": 1, "percent": 25},
        "knowledge": {"due_reviews": 1, "weak_concepts": 3, "stable_concepts": 1,
                      "evidence_backed_concepts": 8},
        "items": [],
        "planned_minutes": 0,
    }


def course_detail(course_id, title):
    """`GET /api/courses/:id` — the course nested beside its counts and lists."""
    return {
        "course": course(course_id, title),
        "counts": {"goals": 1, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0},
        "goals": [], "plans": [], "stages": [], "tasks": [], "sessions": [], "sources": [],
    }


#: Scope isolation: one concept id, three different records.
ISOLATION_GLOBAL = [state("concept_01", "同义替换（全部课程）", "learning", mastery=0.5,
                          origin="manual", evidence_ids=["g1", "g2", "g3"],
                          diagnosis="全局诊断", next_actions=["全局建议"])]
ISOLATION_A = [state("concept_01", "同义替换（课程 A）", "stable", mastery=0.9,
                     origin="derived", evidence_ids=["a1", "a2", "a3", "a4", "a5"],
                     diagnosis="A课程诊断", next_actions=["A课程建议"])]
ISOLATION_B = [state("concept_01", "同义替换（课程 B）", "review_due", mastery=0.3,
                     origin="legacy", provenance_unknown=True,
                     evidence_ids=["b1", "b2"],
                     review_due_at="2026-11-20T00:00:00.000Z",
                     diagnosis="B课程诊断", next_actions=["B课程建议"])]


def base_holder(rows, *, lang=ZH, goals=None):
    rows = localised(rows, lang)
    course_rows = localised(STATE_ROWS, lang) if rows is STATE_ROWS else rows
    title_a = "课程 A" if lang == ZH else "Course A"
    title_b = "课程 B" if lang == ZH else "Course B"
    return {
        "profile": profile(rows, goals=goals or [goal("g1", "读完 CET4 阅读真题", 0.5),
                                                 goal("g2", "背完核心词表", 3)]),
        "courses": [course_summary("course_a", title_a), course_summary("course_b", title_b)],
        "views": {
            "course_a": learner_view("course_a", title_a, course_rows,
                                     goals=[{"goal_id": "ga", "title": f"{title_a} 目标",
                                             "status": "active", "success_criteria": [],
                                             "course_id": "course_a"}]),
            "course_b": learner_view("course_b", title_b, [{
                "concept_id": "concept_01",
                "concept_name": "同义替换（课程 B）" if lang == ZH else "Synonyms (Course B)",
                "domain": "cet4", "mastery": 0.3, "confidence": 0.5, "stability": 0.5,
                "evidence_ids": ["b1", "b2"], "diagnosis": "B课程诊断" if lang == ZH else "B diagnosis",
                "next_actions": [], "origin": "legacy", "provenance_unknown": True,
                "state_label": "review_due", "review_due_at": "2026-11-20T00:00:00.000Z",
            }]),
        },
        "course_fail": False,
        "daily": {"date": "2026-11-24", "daily_minutes": 30, "total_planned_minutes": 0,
                  "notes": [], "courses": [daily_plan("course_a", title_a)]},
        "goal_edit_seq": 20,
        "delay_course_a": False,
    }


# ---------------------------------------------------------------------------
# Page plumbing
# ---------------------------------------------------------------------------

def install_routes(page: Page, holder: dict):
    """Answer every API call from fixtures; emulate the server's PATCH stamps."""
    requests: list[dict] = []
    holder["requests"] = requests
    pending: dict[str, object] = {}
    holder["pending"] = pending

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
            holder["profile"]["goals"] = [updated if g["goal_id"] == goal_id else g for g in goals]
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(updated))

        if path == "/api/learner/recommendations":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"recommendations": [], "generated_at": ""}))

        if path == "/api/courses":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"courses": holder["courses"]}))

        if path == "/api/courses/daily":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["daily"]))

        if path.endswith("/learner") and path.startswith("/api/courses/"):
            course_id = path.split("/")[3]
            if holder.get("course_fail"):
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "服务端暂时不可用"}))
            view = holder["views"].get(course_id)
            if view is None:
                return route.fulfill(status=404, content_type="application/json",
                                     body=json.dumps({"error": "Course not found"}))
            if holder.get("delay_course_a") and course_id == "course_a":
                # Hold the response; the scenario fulfils it after leaving.
                pending["course_a"] = (route, view)
                return None
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(view))

        if path.endswith("/settings") and path.startswith("/api/courses/"):
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"course_id": path.split("/")[3],
                                                  "daily_minutes": None, "updated_at": None}))

        if re.fullmatch(r"/api/courses/course_[ab]", path):
            course_id = path.rsplit("/", 1)[-1]
            title = next(c["title"] for c in holder["courses"] if c["course_id"] == course_id)
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(course_detail(course_id, title)))

        return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

    page.route(API_ROUTE, handler)
    return requests


def open_page(browser, *, width, height, rows=STATE_ROWS, lang=ZH, theme="light",
              goals=None, holder: dict | None = None, url_suffix=""):
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(
        f"localStorage.setItem('inno.theme', {json.dumps(theme)});"
        f"localStorage.setItem('inno.locale', {json.dumps(lang)});"
    )
    state_holder = holder if holder is not None else base_holder(rows, lang=lang, goals=goals)
    install_routes(page, state_holder)
    page.goto((ORIGIN + url_suffix) if url_suffix else BASE, wait_until="networkidle")
    page.wait_for_timeout(500)
    if "page=profile" in (url_suffix or BASE):
        p26.expand_knowledge(page)
    return page, errors, state_holder, state_holder["requests"]


def scope_label(lang=ZH):
    return "选择学习档案范围" if lang == ZH else "Choose profile scope"


def select_scope(page: Page, name: str, lang=ZH):
    trigger = page.get_by_label(re.compile(scope_label(lang)))
    trigger.focus()
    page.keyboard.press("Enter")
    page.get_by_role("option", name=name).click()
    page.wait_for_timeout(900)


def open_profile(page: Page, lang=ZH):
    page.locator(".mla-profile").wait_for(state="visible", timeout=15000)
    page.wait_for_timeout(400)


def open_course_detail(page: Page):
    page.wait_for_timeout(600)
    page.get_by_role("tab", name=re.compile(r"学习概况|Overview")).click()
    page.wait_for_timeout(700)


#: Rows of one region: name, label, tone and bounds. The region is found by its
#: heading/button text, so the three views share one probe.
ROWS_PROBE = """(args) => {
  const [titlePattern, rowSelector] = args;
  const rx = new RegExp(titlePattern);
  const cand = [...document.querySelectorAll('h2,h4,button[aria-expanded]')]
    .find((el) => rx.test((el.textContent || '').trim()));
  const scope = cand ? cand.closest('section') : null;
  if (!scope) return {found: false, rows: []};
  const round = (n) => Math.round(n * 10) / 10;
  const clippers = (el) => {
    const out = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = n.getBoundingClientRect();
      if (b.width <= 0) continue;
      out.push({cls: (n.className || '').toString().slice(0, 40),
                left: round(b.left), right: round(b.right)});
    }
    return out;
  };
  const toneOf = (el) => {
    for (const tone of ['success', 'warning', 'danger', 'accent']) {
      if (el.className.includes('mla-badge--' + tone)) return tone;
    }
    return 'neutral';
  };
  const rows = [...scope.querySelectorAll(rowSelector)].map((row) => {
    const nameEl = row.querySelector('.mla-knowledge-row__name') || row.querySelector('strong');
    // The row can also carry a mastery percentage and a review-date badge;
    // the state badge is the one whose text is one of the six labels.
    const LABELS = ['证据不足', '学习中', '不稳定', '待复习', '稳定', '存在误区',
                    'Insufficient evidence', 'Learning', 'Fragile', 'Unstable', 'Review due',
                    'Stable', 'Misconception'];
    const badges = [...row.querySelectorAll('.mla-badge')];
    const badge = badges.find((b) => LABELS.includes((b.textContent || '').trim())) || null;
    const b = row.getBoundingClientRect();
    return {
      name: nameEl ? (nameEl.textContent || '').trim() : null,
      label: badge ? (badge.textContent || '').trim() : null,
      tone: badge ? toneOf(badge) : null,
      box: {width: round(b.width), height: round(b.height),
            left: round(b.left), right: round(b.right),
            scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
            clippedBy: clippers(row).filter((c) => b.left < c.left - 1 || b.right > c.right + 1)},
    };
  });
  const doc = document.documentElement;
  return {
    found: true,
    rows,
    document: {scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
               overflowsHorizontally: doc.scrollWidth > doc.clientWidth + 1},
    section: {scrollWidth: scope.scrollWidth, clientWidth: scope.clientWidth,
              overflowsHorizontally: scope.scrollWidth > scope.clientWidth + 1},
  };
}"""


def rows_of(page: Page, title_pattern: str, row_selector: str) -> dict:
    return page.evaluate(ROWS_PROBE, [title_pattern, row_selector])


def by_name(result: dict) -> dict:
    return {row["name"]: row for row in result["rows"] if row["name"]}


def assert_rows(results: dict, expected: dict, *, where: str):
    """Every concept present, with the expected label and tone."""
    index = by_name(results)
    for concept_id, (name, label, tone) in expected.items():
        row = index.get(name)
        ensure(row is not None, f"{where}: no row named {name!r} (have {list(index)})")
        ensure(row["label"] == label, f"{where} / {name}: label {row['label']!r} != {label!r}")
        ensure(row["tone"] == tone, f"{where} / {name}: tone {row['tone']!r} != {tone!r}")
        ensure(not row["box"]["clippedBy"], f"{where} / {name}: row clipped {row['box']['clippedBy']}")
        ensure(row["box"]["scrollWidth"] <= row["box"]["clientWidth"] + 1,
               f"{where} / {name}: text overflows its row")
    return index


def save_shot(page: Page, name: str):
    page.screenshot(path=str(SHOTS / name))


def frame_rows(page: Page, selector: str, scope_title: str | None = None):
    """Scroll a matching row to the middle, so the screenshot shows the rows the
    scenario measured rather than the page header above them.

    `scope_title` narrows the search to one section: on the course overview the
    first `.mla-state-row` belongs to the goals card, not to the knowledge list.
    """
    root = page
    if scope_title:
        root = page.locator("section", has=page.get_by_role(
            "heading", name=re.compile(scope_title))).first
    rows = root.locator(selector)
    if rows.count():
        rows.nth(min(2, rows.count() - 1)).evaluate("el => el.scrollIntoView({block: 'center'})")
        page.wait_for_timeout(250)


def record(page: Page, name: str, *, scenario: str, viewport: str, lang: str,
           theme: str, errors: list[str], extra: dict | None = None) -> dict:
    data = measure(page)
    data.update({"file": name, "scenario": scenario, "viewport": viewport,
                 "lang": lang, "theme": theme, "pageErrors": list(errors),
                 "evidenceKind": "simulated API (page.route), browser"})
    if extra:
        data.update(extra)
    return data


def settings(page: Page) -> dict:
    return page.evaluate("""() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      lang: document.documentElement.getAttribute('lang'),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflowsHorizontally: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    })""")


# ---------------------------------------------------------------------------
# B01–B05: the three views, one vocabulary
# ---------------------------------------------------------------------------

def b01_all_courses(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    p26.expand_knowledge(page)
    result = rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row")
    ensure(result["found"], "B01: the knowledge section did not render")
    assert_rows(result, EXPECTED_ZH, where="B01")
    ensure(not result["document"]["overflowsHorizontally"], "B01: page overflows horizontally")

    save_shot(page, "b01-1440-all-courses.png")
    out.append(record(page, "b01-1440-all-courses.png", scenario="B01", viewport="1440x900",
                      lang=ZH, theme="light", errors=errors,
                      extra={"scope": "全部课程", "rows": result["rows"],
                             "labels": {r["name"]: r["label"] for r in result["rows"]}}))
    ensure(not errors, f"B01: page errors {errors}")
    page.close()


def b02_course_scope(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    select_scope(page, "课程 A")
    result = rows_of(page, "知识掌握|Knowledge mastery", ".mla-course-knowledge-row")
    ensure(result["found"], "B02: the course knowledge section did not render")
    assert_rows(result, EXPECTED_ZH, where="B02")
    ensure(not result["document"]["overflowsHorizontally"], "B02: page overflows horizontally")
    # Read-only: no editor is mounted in this scope.
    ensure(page.locator("textarea").count() == 0, "B02: the course view mounted an editor")

    save_shot(page, "b02-1440-course-a.png")
    out.append(record(page, "b02-1440-course-a.png", scenario="B02", viewport="1440x900",
                      lang=ZH, theme="light", errors=errors,
                      extra={"scope": "课程 A", "rows": result["rows"],
                             "labels": {r["name"]: r["label"] for r in result["rows"]},
                             "readOnly": page.locator("input, textarea").count() == 0}))
    ensure(not errors, f"B02: page errors {errors}")
    page.close()


def b03_course_overview(browser, out):
    page, errors, holder, requests = open_page(
        browser, width=1440, height=900, url_suffix="?page=course&course=course_a&view=overview")
    open_course_detail(page)
    result = rows_of(page, "学习概况|Overview", ".mla-state-row")
    ensure(result["found"], "B03: the overview knowledge section did not render")
    ensure(len(result["rows"]) >= 8, f"B03: expected eight rows, got {len(result['rows'])}")
    assert_rows(result, EXPECTED_ZH, where="B03")
    ensure(not result["document"]["overflowsHorizontally"], "B03: page overflows horizontally")

    frame_rows(page, ".mla-state-row", "学习概况|Overview")
    save_shot(page, "b03-1440-course-overview.png")
    out.append(record(page, "b03-1440-course-overview.png", scenario="B03", viewport="1440x900",
                      lang=ZH, theme="light", errors=errors,
                      extra={"scope": "课程详情·学习概况", "rows": result["rows"],
                             "labels": {r["name"]: r["label"] for r in result["rows"]}}))
    ensure(not errors, f"B03: page errors {errors}")
    page.close()


def b04_three_views_same(browser, out):
    """One concept id, three views, identical labels and tones."""
    views = []
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    p26.expand_knowledge(page)
    views.append(("all", rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row")))
    select_scope(page, "课程 A")
    views.append(("course", rows_of(page, "知识掌握|Knowledge mastery", ".mla-course-knowledge-row")))
    save_shot(page, "b04-three-views-course.png")
    ensure(not errors, f"B04: page errors {errors}")
    page.close()

    page, errors2, holder, requests = open_page(
        browser, width=1440, height=900, url_suffix="?page=course&course=course_a&view=overview")
    open_course_detail(page)
    views.append(("overview", rows_of(page, "学习概况|Overview", ".mla-state-row")))
    save_shot(page, "b04-three-views-overview.png")
    ensure(not errors2, f"B04: page errors {errors2}")
    page.close()

    # Compare per concept, not per view order.
    maps = []
    for name, result in views:
        maps.append((name, {row["name"]: (row["label"], row["tone"]) for row in result["rows"]}))
    reference = maps[0][1]
    for name, index in maps[1:]:
        for concept_name, pair in reference.items():
            ensure(index.get(concept_name) == pair,
                   f"B04: {name} disagrees about {concept_name!r}: {index.get(concept_name)} != {pair}")

    out.append({"scenario": "B04", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": [], "views": [{"view": n, "rows": r["rows"],
                                             "document": r["document"], "section": r["section"]}
                                            for n, r in views],
                "identical": True,
                "conceptCount": len(reference)})


def b05_missing_and_illegal(browser, out):
    """The two degradations, in all three views, with no success tone and no leak."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    p26.expand_knowledge(page)
    all_result = rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row")
    all_rows = by_name(all_result)
    select_scope(page, "课程 A")
    course_result = rows_of(page, "知识掌握|Knowledge mastery", ".mla-course-knowledge-row")
    course_rows = by_name(course_result)
    save_shot(page, "b05-320?skip.png" if False else "b05-course-view.png")
    ensure(not errors, f"B05: page errors {errors}")
    body_text = page.inner_text("body")
    ensure("brand_new_state" not in body_text, "B05: the illegal label leaked into the course view")
    page.close()

    page, errors2, holder, requests = open_page(
        browser, width=1440, height=900, url_suffix="?page=course&course=course_a&view=overview")
    open_course_detail(page)
    overview_result = rows_of(page, "学习概况|Overview", ".mla-state-row")
    overview_rows = by_name(overview_result)
    body_text = page.inner_text("body")
    ensure("brand_new_state" not in body_text, "B05: the illegal label leaked into the overview")
    ensure(not errors2, f"B05: page errors {errors2}")
    save_shot(page, "b05-overview.png")
    page.close()

    for where, index in (("all", all_rows), ("course", course_rows), ("overview", overview_rows)):
        for name in ("无标签概念", "非法状态概念"):
            row = index.get(name)
            ensure(row is not None, f"B05 / {where}: no row {name!r}")
            ensure(row["label"] == "证据不足", f"B05 / {where} / {name}: {row['label']!r}")
            ensure(row["tone"] == "neutral", f"B05 / {where} / {name}: tone {row['tone']!r}")

    out.append({"scenario": "B05", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": [], "views": {
                    "all": [all_rows[n] for n in ("无标签概念", "非法状态概念")],
                    "course": [course_rows[n] for n in ("无标签概念", "非法状态概念")],
                    "overview": [overview_rows[n] for n in ("无标签概念", "非法状态概念")],
                }, "rawStringLeaked": False,
                "pageState": {"all": all_result["document"], "course": course_result["document"],
                              "overview": overview_result["document"]}})


# ---------------------------------------------------------------------------
# B06–B08: isolation, filters, review eligibility
# ---------------------------------------------------------------------------

def isolation_holder():
    holder = base_holder(STATE_ROWS)
    holder["profile"]["knowledge_states"] = ISOLATION_GLOBAL
    holder["views"]["course_a"] = learner_view("course_a", "课程 A", ISOLATION_A,
                                               goals=[{"goal_id": "ga", "title": "A 课程目标",
                                                       "status": "active", "success_criteria": [],
                                                       "course_id": "course_a"}])
    holder["views"]["course_b"] = learner_view("course_b", "课程 B", ISOLATION_B,
                                               goals=[{"goal_id": "gb", "title": "B 课程目标",
                                                       "status": "active", "success_criteria": [],
                                                       "course_id": "course_b"}])
    return holder


def b06_same_concept_scope(browser, out):
    holder = isolation_holder()
    page, errors, holder, requests = open_page(browser, width=1440, height=900, holder=holder)
    open_profile(page)
    p26.expand_knowledge(page)
    steps = []

    def snapshot(label, selector_title, selector):
        result = rows_of(page, selector_title, selector)
        names = [row["name"] for row in result["rows"]]
        text = page.inner_text("body")
        steps.append({"scope": label, "names": names, "rows": result["rows"],
                      "hasGlobal": "同义替换（全部课程）" in text,
                      "hasA": "同义替换（课程 A）" in text,
                      "hasB": "同义替换（课程 B）" in text})
        return result

    snapshot("全部课程", "知识状态|Knowledge", ".mla-knowledge-row")
    select_scope(page, "课程 A")
    snapshot("课程 A", "知识掌握|Knowledge mastery", ".mla-course-knowledge-row")
    select_scope(page, "课程 B")
    snapshot("课程 B", "知识掌握|Knowledge mastery", ".mla-course-knowledge-row")
    save_shot(page, "b06-course-b.png")
    select_scope(page, "全部课程")
    snapshot("回到全部课程", "知识状态|Knowledge", ".mla-knowledge-row")
    page_state = settings(page)
    ensure(not errors, f"B06: page errors {errors}")
    page.close()

    ensure(steps[0]["hasGlobal"] and not steps[0]["hasA"] and not steps[0]["hasB"], f"B06: {steps[0]}")
    ensure(steps[1]["hasA"] and not steps[1]["hasGlobal"] and not steps[1]["hasB"], f"B06: {steps[1]}")
    ensure(steps[2]["hasB"] and not steps[2]["hasA"] and not steps[2]["hasGlobal"], f"B06: {steps[2]}")
    ensure(steps[3]["hasGlobal"] and not steps[3]["hasA"], f"B06: {steps[3]}")
    out.append({"scenario": "B06", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": [], "steps": steps,
                "conceptId": "concept_01", "mergedAcrossScopes": False,
                "pageState": page_state})


def b07_filters_per_scope(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    p26.expand_knowledge(page)

    def filter_counts():
        section = p26.knowledge_section(page).first
        buttons = [b for b in section.locator("button[aria-pressed]").all()]
        return {b.inner_text().strip(): b.inner_text().strip() for b in buttons}

    before = filter_counts()
    # Global: six filters over the eight rows (unknown 2, stable 1, review 1 ...).
    section = p26.knowledge_section(page).first
    labels = [b.inner_text().split("\n")[0].strip() for b in section.locator("button[aria-pressed]").all()]
    ensure("全部" in labels, f"B07: no filter row, have {labels}")

    before_rows = len(rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row")["rows"])
    # Click 稳定, then 证据不足, and count what stays visible.
    section.get_by_role("button", name=re.compile(r"^稳定")).click()
    page.wait_for_timeout(400)
    stable_rows = by_name(rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row"))
    ensure(list(stable_rows) == ["长难句拆分"], f"B07: stable filter shows {list(stable_rows)}")

    section.get_by_role("button", name=re.compile(r"^证据不足")).click()
    page.wait_for_timeout(400)
    unknown_rows = by_name(rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row"))
    ensure(set(unknown_rows) == {"未知状态概念", "无标签概念", "非法状态概念"},
           f"B07: unknown filter shows {list(unknown_rows)}")
    save_shot(page, "b07-unknown-filter.png")

    select_scope(page, "课程 A")
    course_section = page.locator("section", has=page.get_by_role("heading", name="知识掌握")).first
    course_labels = [b.inner_text().split("\n")[0].strip()
                     for b in course_section.locator("button[aria-pressed]").all()]
    ensure("全部" in course_labels, f"B07: the course view lost its filters: {course_labels}")
    course_rows = rows_of(page, "知识掌握|Knowledge mastery", ".mla-course-knowledge-row")
    ensure(len(course_rows["rows"]) == 8, f"B07: course scope shows {len(course_rows['rows'])} rows")
    page_state = settings(page)
    ensure(not errors, f"B07: page errors {errors}")
    page.close()

    out.append({"scenario": "B07", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": [], "globalRows": before_rows,
                "globalFilters": labels, "stableFilter": list(stable_rows),
                "unknownFilter": sorted(unknown_rows), "courseFilters": course_labels,
                "courseRows": len(course_rows["rows"]), "countsBefore": before,
                "pageState": page_state})


def b08_review_boundary(browser, out):
    holder = base_holder(STATE_ROWS)
    holder["profile"]["knowledge_states"] = [
        state("k_due", "有证据且已到期", "review_due", review_due_at="2026-11-20T00:00:00.000Z",
              origin="derived", evidence_ids=["e1"]),
        state("k_no_evidence", "待复习但无证据", "review_due", review_due_at="2026-11-20T00:00:00.000Z",
              evidence_ids=[]),
        state("k_unknown_source", "待复习但来源不明", "review_due", review_due_at="2026-11-20T00:00:00.000Z",
              provenance_unknown=True),
        state("k_future", "待复习但日期在未来", "review_due", review_due_at="2099-01-01T00:00:00.000Z"),
        state("k_learning_due", "学习中但日期已过", "learning", review_due_at="2026-11-20T00:00:00.000Z"),
    ]
    page, errors, holder, requests = open_page(browser, width=1440, height=900, holder=holder)
    open_profile(page)
    p26.expand_knowledge(page)

    index = by_name(rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row"))
    for name in ("有证据且已到期", "待复习但无证据", "待复习但来源不明", "待复习但日期在未来",
                 "学习中但日期已过"):
        ensure(index.get(name) is not None, f"B08: missing row {name!r}")
        ensure(index[name]["label"] == ("学习中" if name == "学习中但日期已过" else "待复习"),
               f"B08 / {name}: {index[name]['label']!r}")

    # The tally is a state count, and the page says so. No surface claims the
    # five rows are five formal reviews.
    tile = page.get_by_text("待复习状态").locator("xpath=..")
    tile_value = tile.locator(".text-2xl").inner_text().strip()
    ensure(tile_value == "4", f"B08: the review_due tally reads {tile_value!r}, expected 4")
    hint = page.get_by_text("仅统计知识状态，不代表已通过到期复习资格核查")
    ensure(hint.count() == 1, "B08: the tally's eligibility caveat is missing")

    body = page.inner_text("body")
    for forbidden in ("符合复习资格", "已获得复习资格", "今日到期 5"):
        ensure(forbidden not in body, f"B08: the page claims {forbidden!r}")

    frame_rows(page, ".mla-knowledge-row")
    save_shot(page, "b08-review-boundary.png")
    out.append(record(page, "b08-review-boundary.png", scenario="B08", viewport="1440x900",
                      lang=ZH, theme="light", errors=errors,
                      extra={"reviewDueTally": tile_value, "hint": hint.inner_text(),
                             "rows": index,
                             "evidenceGatedServerSide": "see src/courses/daily-plan.test.ts"}))
    ensure(not errors, f"B08: page errors {errors}")
    page.close()


# ---------------------------------------------------------------------------
# B09–B10: editing safety
# ---------------------------------------------------------------------------

def b09_draft_guard_scope_switch(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    row = p26.open_row(page, "同义替换")
    row.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(300)
    textarea = row.locator("textarea").first
    ensure(textarea.count() == 1, "B09: no editor textarea")
    textarea.fill("未保存的诊断草稿")
    page.wait_for_timeout(200)

    # First attempt: dismiss the confirm. The scope must not change and the
    # draft must survive — the guard refuses, it does not silently discard.
    dialogs: list[str] = []
    page.once("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    select_scope_without_wait(page, "课程 A")
    page.wait_for_timeout(600)
    ensure(dialogs, "B09: switching scope did not ask about the unsaved draft")
    trigger_text = page.get_by_label(re.compile(scope_label())).inner_text()
    ensure("课程 A" not in trigger_text, f"B09: the scope changed despite the refusal: {trigger_text!r}")
    ensure(page.locator(".mla-profile-body").inner_text().find("同义替换") >= 0,
           "B09: the global panel was unmounted by a refused switch")
    ensure(page.locator(".mla-profile-body textarea").first.input_value() == "未保存的诊断草稿",
           "B09: the draft was lost on a refused switch")
    save_shot(page, "b09-draft-refused.png")

    # Second attempt: accept. The scope changes and the editor goes with it.
    page.once("dialog", lambda d: d.accept())
    select_scope_without_wait(page, "课程 A")
    page.wait_for_timeout(900)
    ensure("课程 A" in page.get_by_label(re.compile(scope_label())).inner_text(),
           "B09: the accepted switch did not change the scope")
    ensure(page.locator(".mla-profile-body textarea").count() == 0,
           "B09: the discarded editor stayed mounted after the accepted switch")

    save_shot(page, "b09-draft-guard.png")
    out.append({"scenario": "B09", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": list(errors), "dialogMessages": dialogs,
                "refusedSwitchKeptDraft": True, "acceptedSwitchChangedScope": True,
                "requestsDuringDraft": len(requests_to(requests, "/api/learner/profile/knowledge")),
                "pageState": settings(page)})
    ensure(not errors, f"B09: page errors {errors}")
    page.close()


def select_scope_without_wait(page: Page, name: str):
    trigger = page.get_by_label(re.compile(scope_label()))
    trigger.focus()
    page.keyboard.press("Enter")
    page.get_by_role("option", name=name).click()


def b10_goal_passive_update(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900)
    open_profile(page)
    section = p26.goal_section(page).first
    section.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    card = section.locator("div.rounded-xl", has_text="读完 CET4").first
    handle = card.element_handle()
    card.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(250)

    before = json.loads(json.dumps(holder["profile"]["goals"][0]))
    # The server pauses the goal while the editor is open.
    holder["profile"]["goals"][0]["status"] = "paused"
    holder["profile"]["goals"][0]["manual"] = {**before.get("manual", {}),
                                               "status": {"at_seq": 0, "edit": 90}}
    server_record = json.loads(json.dumps(holder["profile"]["goals"][0]))
    page.get_by_role("button", name=re.compile(r"^刷新$|^Refresh$")).click()
    page.wait_for_timeout(700)

    slider = handle.query_selector("input[type=range]")
    ensure(slider is not None, "B10: no priority slider")
    slider.focus()
    page.keyboard.press("Home")
    for _ in range(40):
        page.keyboard.press("ArrowRight")
    page.wait_for_timeout(150)
    buttons = r1.editor_buttons(handle)
    save = buttons.get("保存") or buttons.get("Save")
    ensure(save is not None, f"B10: no save button, have {list(buttons)}")
    save.click()
    page.wait_for_timeout(700)

    bodies = r1.goal_patch_bodies(requests, "g1")
    ensure(len(bodies) == 1, f"B10: expected one PATCH, got {len(bodies)}")
    ensure(bodies[0] == {"priority": 0.4}, f"B10: body {bodies[0]!r}")
    after = holder["profile"]["goals"][0]
    ensure(after["status"] == "paused", f"B10: status became {after['status']!r}")
    ensure(after["manual"]["status"] == server_record["manual"]["status"],
           "B10: manual.status was re-stamped by a priority-only save")

    save_shot(page, "b10-goal-passive-update.png")
    out.append({"scenario": "B10", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": list(errors), "goalBefore": before, "serverUpdate": server_record,
                "userEditedFields": ["priority"], "patchBody": bodies[0],
                "goalAfter": after, "statusStayed": after["status"],
                "pageState": settings(page)})
    ensure(not errors, f"B10: page errors {errors}")
    page.close()


# ---------------------------------------------------------------------------
# B11–B16: responsive, language, theme
# ---------------------------------------------------------------------------

def responsive_scene(browser, out, *, name, width, rows, selector, title, scope_name=None,
                     lang=ZH, theme="light", suffix=""):
    page, errors, holder, requests = open_page(
        browser, width=width, height=640, rows=rows, lang=lang, theme=theme, url_suffix=suffix)
    if "page=profile" in (suffix or BASE):
        open_profile(page, lang)
        if scope_name:
            select_scope(page, scope_name, lang)
    else:
        open_course_detail(page)
    result = rows_of(page, title, selector)
    ensure(result["found"], f"{name}: region not found")
    assert_rows(result, EXPECTED_EN if lang == EN else EXPECTED_ZH, where=name)
    ensure(not result["document"]["overflowsHorizontally"], f"{name}: page overflows horizontally")
    ensure(not result["section"]["overflowsHorizontally"], f"{name}: section overflows horizontally")

    frame_rows(page, selector, "学习概况|Overview" if selector == ".mla-state-row" else None)
    save_shot(page, f"{name.lower()}-{width}.png")
    data = record(page, f"{name.lower()}-{width}.png", scenario=name,
                  viewport=f"{width}x640", lang=lang, theme=theme, errors=errors,
                  extra={"rows": result["rows"], "scope": scope_name or "全部课程",
                         "sectionOverflow": result["section"]["overflowsHorizontally"],
                         "settings": settings(page)})
    out.append(data)
    ensure(not errors, f"{name}: page errors {errors}")
    page.close()
    return data


def b11_320_all(browser, out):
    responsive_scene(browser, out, name="B11", width=320, rows=STATE_ROWS,
                     selector=".mla-knowledge-row", title="知识状态|Knowledge")


def b12_320_course(browser, out):
    responsive_scene(browser, out, name="B12", width=320, rows=STATE_ROWS,
                     selector=".mla-course-knowledge-row", title="知识掌握|Knowledge mastery",
                     scope_name="课程 A")


def b13_320_overview(browser, out):
    responsive_scene(browser, out, name="B13", width=320, rows=STATE_ROWS,
                     selector=".mla-state-row", title="学习概况|Overview",
                     suffix="?page=course&course=course_a&view=overview")


def b14_390_long_name(browser, out):
    long_name = "这是一个非常非常长的中文知识点名称用来测试换行行为是否正常"
    rows = [state("k_long", long_name, "learning", mastery=0.5)]
    page, errors, holder, requests = open_page(browser, width=390, height=844, rows=rows)
    open_profile(page)
    p26.expand_knowledge(page)
    result = rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row")
    row = assert_rows(result, {"k_long": (long_name, "学习中", "accent")}, where="B14")[long_name]
    ensure(row["box"]["height"] > 20, f"B14: the long name collapsed to {row['box']['height']}px")
    ensure(not result["document"]["overflowsHorizontally"], "B14: page overflows horizontally")
    save_shot(page, "b14-390-long-name.png")
    out.append(record(page, "b14-390-long-name.png", scenario="B14", viewport="390x844",
                      lang=ZH, theme="light", errors=errors, extra={"row": row}))
    ensure(not errors, f"B14: page errors {errors}")
    page.close()


def b15_english_three_views(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               rows=STATE_ROWS, lang=EN)
    open_profile(page, EN)
    p26.expand_knowledge(page)
    all_result = rows_of(page, "Knowledge", ".mla-knowledge-row")
    all_rows = all_result
    assert_rows(all_rows, EXPECTED_EN, where="B15/all")
    select_scope(page, "Course A", EN)
    course_result = rows_of(page, "Knowledge mastery", ".mla-course-knowledge-row")
    course_rows = course_result
    assert_rows(course_rows, EXPECTED_EN, where="B15/course")
    body = page.inner_text("body")
    for zh_text in ("学习中", "证据不足", "待复习", "存在误区"):
        ensure(zh_text not in body, f"B15: Chinese label {zh_text!r} leaked into the English course view")
    save_shot(page, "b15-en-course.png")
    ensure(not errors, f"B15: page errors {errors}")
    page.close()

    page, errors2, holder, requests = open_page(
        browser, width=1440, height=900, rows=STATE_ROWS, lang=EN,
        url_suffix="?page=course&course=course_a&view=overview")
    open_course_detail(page)
    overview_result = rows_of(page, "Overview", ".mla-state-row")
    overview_rows = overview_result
    assert_rows(overview_rows, EXPECTED_EN, where="B15/overview")
    frame_rows(page, ".mla-state-row", "Overview")
    body = page.inner_text("body")
    for zh_text in ("学习中", "证据不足", "待审核"):
        ensure(zh_text not in body, f"B15: Chinese label {zh_text!r} leaked into the English overview")
    save_shot(page, "b15-en-overview.png")
    ensure(not errors2, f"B15: page errors {errors2}")
    page.close()

    out.append({"scenario": "B15", "viewport": "1440x900", "lang": EN, "theme": "light",
                "pageErrors": [], "views": [
                    {"view": "all", "rows": all_rows["rows"], "document": all_result["document"]},
                    {"view": "course", "rows": course_rows["rows"], "document": course_result["document"]},
                    {"view": "overview", "rows": overview_rows["rows"], "document": overview_result["document"]},
                ], "chineseLeak": False})


def b16_dark_theme(browser, out):
    page, errors, holder, requests = open_page(browser, width=1440, height=900, theme="dark")
    open_profile(page)
    p26.expand_knowledge(page)
    result = rows_of(page, "知识状态|Knowledge", ".mla-knowledge-row")
    assert_rows(result, EXPECTED_ZH, where="B16")
    theme = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
    ensure(theme == "dark", f"B16: theme is {theme!r}")
    # Provenance notes must still be readable (not clipped, not empty).
    notes = page.locator(".mla-provenance__region-notes")
    if notes.count():
        ensure(notes.first.inner_text().strip() != "", "B16: the provenance caveats are empty in dark mode")
    ensure(not result["document"]["overflowsHorizontally"], "B16: page overflows horizontally")
    frame_rows(page, ".mla-knowledge-row")
    save_shot(page, "b16-dark-all-courses.png")
    out.append(record(page, "b16-dark-all-courses.png", scenario="B16", viewport="1440x900",
                      lang=ZH, theme="dark", errors=errors,
                      extra={"rows": result["rows"], "themeApplied": theme,
                             "provenanceNotes": notes.count()}))
    ensure(not errors, f"B16: page errors {errors}")
    page.close()


# ---------------------------------------------------------------------------
# B17–B18: empty / failure / recovery / late response
# ---------------------------------------------------------------------------

def b17_empty_and_failure(browser, out):
    holder = base_holder(STATE_ROWS)
    holder["profile"]["knowledge_states"] = []
    holder["views"]["course_a"] = learner_view("course_a", "课程 A", [])
    page, errors, holder, requests = open_page(browser, width=1440, height=900, holder=holder)
    open_profile(page)
    body = page.inner_text(".mla-profile-body")
    ensure("还没有已记录的知识点" in body or "暂无" in body, f"B17: no empty copy, body={body[:200]!r}")
    select_scope(page, "课程 A")
    body = page.inner_text(".mla-profile-body")
    ensure("这门课程还没有带证据的知识点" in body, f"B17: no course empty copy: {body[:200]!r}")
    save_shot(page, "b17-empty.png")
    ensure(not errors, f"B17/empty: page errors {errors}")
    page.close()

    holder = base_holder(STATE_ROWS)
    holder["course_fail"] = True
    page, errors, holder, requests = open_page(browser, width=1440, height=900, holder=holder)
    open_profile(page)
    select_scope(page, "课程 A")
    body = page.inner_text(".mla-profile-body")
    ensure("知识掌握" not in body, "B17: a failed read still rendered the knowledge section")
    ensure(page.locator(".mla-badge--success").count() == 0,
           "B17: a failed read painted a success badge")
    save_shot(page, "b17-failure.png")

    # Recovery: the same scope succeeds on retry, with its own records.
    holder["course_fail"] = False
    page.get_by_label(re.compile(scope_label())).focus()
    page.keyboard.press("Enter")
    page.get_by_role("option", name=("全部课程" if ZH else "All courses")).click()
    page.wait_for_timeout(500)
    select_scope(page, "课程 A")
    index = by_name(rows_of(page, "知识掌握|Knowledge mastery", ".mla-course-knowledge-row"))
    ensure(index, "B17: recovery did not render the course records")
    save_shot(page, "b17-recovered.png")
    page_state = settings(page)
    ensure(not errors, f"B17/failure: page errors {errors}")
    page.close()

    out.append({"scenario": "B17", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": [], "emptyGlobal": True, "emptyCourse": True,
                "failureShowedNoSuccess": True, "recoveredRows": sorted(index),
                "pageState": page_state})


def b18_fast_switch_delayed(browser, out):
    holder = base_holder(STATE_ROWS)
    holder["delay_course_a"] = True
    page, errors, holder, requests = open_page(browser, width=1440, height=900, holder=holder)
    open_profile(page)
    select_scope_without_wait(page, "课程 A")
    page.wait_for_timeout(300)
    select_scope_without_wait(page, "课程 B")
    page.wait_for_timeout(900)
    body_before = page.inner_text(".mla-profile-body")
    ensure("课程 B" in body_before or "B课程诊断" in body_before,
           f"B18: course B did not render: {body_before[:160]!r}")

    # Deliver A's response now — it must be dropped.
    pending = holder["pending"].get("course_a")
    ensure(pending is not None, "B18: no pending course A response was held")
    route, view = pending
    route.fulfill(status=200, content_type="application/json", body=json.dumps(view))
    page.wait_for_timeout(900)

    body_after = page.inner_text(".mla-profile-body")
    ensure("同义替换（课程 A）" not in body_after, "B18: the late A response overwrote course B")
    ensure("A课程诊断" not in body_after, "B18: A's diagnosis appeared after the late response")
    save_shot(page, "b18-late-response.png")
    out.append({"scenario": "B18", "viewport": "1440x900", "lang": ZH, "theme": "light",
                "pageErrors": list(errors), "lateResponseDropped": True,
                "bodyAfter": body_after[:400], "pageState": settings(page)})
    ensure(not errors, f"B18: page errors {errors}")
    page.close()


# ---------------------------------------------------------------------------
# Known issue K-01: 320px collapsed goal card
# ---------------------------------------------------------------------------

def known_issue_goal_card(browser) -> dict:
    """Measure the pre-existing 320px goal-card squeeze (registered, not fixed)."""
    page, errors, holder, requests = open_page(browser, width=320, height=640)
    open_profile(page)
    section = p26.goal_section(page).first
    section.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    data = page.evaluate("""() => {
      const sec = [...document.querySelectorAll('section')]
        .find((s) => /学习目标/.test(s.querySelector('h4')?.textContent || ''));
      const card = sec ? sec.querySelector('.rounded-xl') : null;
      if (!card) return null;
      const title = card.querySelector('div');
      const right = card.lastElementChild;
      const box = (el) => { const b = el.getBoundingClientRect();
        return {left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width)}; };
      return {card: box(card), titleColumn: box(title), actionGroup: box(right),
              documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1};
    }""")
    ensure(data is not None, "K-01: no goal card at 320px")
    page.screenshot(path=str(ASSETS / "known-issue-320-goal-card.png"))
    data["pageErrors"] = list(errors)
    page.close()
    return data


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

SCENARIOS = {
    "b01": b01_all_courses, "b02": b02_course_scope, "b03": b03_course_overview,
    "b04": b04_three_views_same, "b05": b05_missing_and_illegal,
    "b06": b06_same_concept_scope, "b07": b07_filters_per_scope,
    "b08": b08_review_boundary, "b09": b09_draft_guard_scope_switch,
    "b10": b10_goal_passive_update, "b11": b11_320_all, "b12": b12_320_course,
    "b13": b13_320_overview, "b14": b14_390_long_name, "b15": b15_english_three_views,
    "b16": b16_dark_theme, "b17": b17_empty_and_failure, "b18": b18_fast_switch_delayed,
}


def main():
    """`python qa_p2_7.py b01 b03` runs a subset and skips the regression suite."""
    only = [arg.lower() for arg in sys.argv[1:] if arg.lower() in SCENARIOS]
    SHOTS.mkdir(parents=True, exist_ok=True)
    REGRESSION.mkdir(parents=True, exist_ok=True)

    out: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            if only:
                for key in only:
                    SCENARIOS[key](browser, out)
                print(f"OK: subset {only} -> {len(out)} scenarios")
                return
            b01_all_courses(browser, out)
            b02_course_scope(browser, out)
            b03_course_overview(browser, out)
            b04_three_views_same(browser, out)
            b05_missing_and_illegal(browser, out)
            b06_same_concept_scope(browser, out)
            b07_filters_per_scope(browser, out)
            b08_review_boundary(browser, out)
            b09_draft_guard_scope_switch(browser, out)
            b10_goal_passive_update(browser, out)
            b11_320_all(browser, out)
            b12_320_course(browser, out)
            b13_320_overview(browser, out)
            b14_390_long_name(browser, out)
            b15_english_three_views(browser, out)
            b16_dark_theme(browser, out)
            b17_empty_and_failure(browser, out)
            b18_fast_switch_delayed(browser, out)
            known = known_issue_goal_card(browser)

            # --- P2-6-R2 regression: 7 R2 + 19 R1, artefacts redirected ---
            r2.R2_DIR = REGRESSION
            r1.R1_DIR = REGRESSION / "r1-rerun"
            (REGRESSION / "r1-rerun").mkdir(parents=True, exist_ok=True)
            p26.ASSETS = REGRESSION / "r1-rerun"

            r2_out: list[dict] = []
            r2.b01_status_then_priority(browser, r2_out)
            r2.b02_title_then_status(browser, r2_out)
            r2.b03_type_criteria_then_title(browser, r2_out)
            r2.b04_multi_update_no_edit(browser, r2_out)
            r2.b05_refresh_cancel_reopen(browser, r2_out)
            r2.b06_failure_refresh_retry(browser, r2_out)
            r2.b07_320_anomaly_endpoint(browser, r2_out)

            r1_out: list[dict] = []
            r1.r01_title_only_anomaly(browser, r1_out)
            r1.r02_status_only_normal(browser, r1_out)
            r1.r03_active_change(browser, r1_out)
            r1.r04_passive_update(browser, r1_out)
            r1.r05_cancel_and_failure(browser, r1_out)
            r1.r06_course_notes_320(browser, r1_out)
            r1.r07_english_320(browser, r1_out)
            r1.r08_bad_evidence_arrays(browser, r1_out)
            b: list[dict] = []
            p26.b01_1440_all_courses(browser, b)
            p26.b02_390_stacked(browser, b)
            r1.b03_unknown_source_r1(browser, b)
            p26.b04_320_english(browser, b)
            p26.b05_dark(browser, b)
            p26.b06_manual_save_success(browser, b)
            p26.b07_save_failure(browser, b)
            p26.b08_legacy_mirror(browser, b)
            b09: list[dict] = []
            r1.b09_goal_priority_r1(browser, b09)
            p26.b10_course_320(browser, b)

            regression = r2_out + r1_out + b + b09

            METRICS.write_text(json.dumps({
                "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
                "base": BASE,
                "evidenceKinds": {
                    "p2_7": "simulated API (page.route) + real browser",
                    "regression": "P2-6-R2 scenarios executed from qa_p2_6_r2.py / qa_p2_6_r1.py",
                    "realRoute": ("server rules proven by Vitest: src/courses/daily-plan.test.ts, "
                                  "src/server/routes/learner.goal-priority.test.ts"),
                },
                "note": ("E4.9i-P2-7. B01-B18 cover the three views, scope isolation, the "
                         "review-eligibility boundary, editing safety and the 320/390/en/dark "
                         "matrix. The 26 P2-6-R2 scenarios are re-run from their own modules "
                         "into regression-r2/; no earlier asset is overwritten."),
                "knownIssue": known,
                "scenarios": out,
                "regression": regression,
                "regressionCount": len(regression),
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(out)} P2-7 scenarios + {len(regression)} regression entries -> {METRICS}")
            print("known issue K-01:", json.dumps(known, ensure_ascii=False))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
