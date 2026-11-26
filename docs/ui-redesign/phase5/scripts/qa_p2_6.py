"""E4.9i-P2-6 browser acceptance: record source, evidence count, goal priority.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_6.py

Every /api request is answered by `page.route` fixtures defined here, so no real
learner data is read or written and no backend is needed. Outputs go to
`P2-6-assets/`; the P2-5 and P2-5-R1 evidence is not touched.

What this proves, which jsdom cannot:

* the copy that is actually painted, in both languages and both themes;
* that an unrecognised `origin` reads 「来源未标明」 and never 「系统推导」;
* that `provenance_unknown` shows independently of the origin label, and that
  a record with both fields shows both;
* the evidence count as stored (duplicates and legacy mirrors included) and the
  "not available" wording when the field cannot be read;
* that a save sends exactly the three editable fields, that the label afterwards
  is the one the *server* returned, and that a failed save keeps the draft and
  the original source;
* that an anomalous goal priority renders its raw value, survives a title-only
  save unchanged, and is never rewritten by opening or cancelling the editor;
* real element bounds and clipping (the same reasoning as P2-5-R1: `width > 0`
  is also true of a box cut in half by an `overflow: hidden` ancestor);
* no page-level horizontal overflow and no `pageerror` in any scenario.

This is deliberately a separate file from `qa_p2_5.py`: different fixtures (it
has to emulate the server's `origin: "manual"` rule), different assertions, and
a different output directory. Sharing the module would let a P2-5 edit change
what P2-6 evidence means.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "http://127.0.0.1:5193/?page=profile"
API_ROUTE = re.compile(r"^http://127\.0\.0\.1:5193/api/")
PHASE = Path(__file__).resolve().parents[1]
ASSETS = PHASE / "P2-6-assets"
METRICS = ASSETS / "p26-browser-metrics.json"

TODAY = "2026-11-24T08:00:00.000Z"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def state(concept_id, name, label="learning", **extra):
    """One knowledge state. `extra` carries the provenance fields under test.

    `evidence_ids` is omitted when the caller passes `evidence=None`, which is
    how the "field cannot be read" case is produced: the record then has no
    `evidence_ids` at all, exactly like an older server payload.
    """
    base = {
        "concept_id": concept_id,
        "concept_name": name,
        "domain": "cet4",
        "state_label": label,
        "mastery": 0.5,
        "confidence": 0.5,
        "stability": 0.5,
        "diagnosis": "诊断文本。",
        "next_actions": ["复习同义替换"],
    }
    evidence = extra.pop("evidence", ["e1"])
    if evidence is not None:
        base["evidence_ids"] = evidence
    base.update(extra)
    return base


def goal(goal_id, title, priority, *, status="active"):
    return {
        "goal_id": goal_id,
        "title": title,
        "type": "skill",
        "status": status,
        "priority": priority,
        "success_criteria": ["能读懂 90% 的段落"],
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


LONG_ZH = "这是一个非常非常长的中文知识点名称用来测试换行行为是否正常"
LONG_EN = "A very long English concept name that should wrap instead of being clipped"

# The six provenance cases the task book names, one record each:
#
#   derived        2 identifiers
#   manual         0 identifiers, provenance known
#   legacy         3 identifiers — a mirror and its source plus a duplicate, so
#                  the count proves nothing is deduplicated
#   (no origin)    1 identifier, never flagged
#   "imported"     an origin this build does not know — must not read as derived
#   legacy+unknown both fields at once, evidence field unreadable
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

PROFILE_EN = profile([
    state("k_derived", "Substitute words", "learning", origin="derived",
          provenance_unknown=False, evidence=["e1", "e2"]),
    state("k_manual", "Subjunctive mood", "stable", origin="manual",
          provenance_unknown=False, evidence=[]),
    state("k_legacy", "Connector logic", "review_due", origin="legacy",
          provenance_unknown=True, evidence=["legacy_1", "event_1", "legacy_1"]),
    state("k_none", "Long sentence parsing", "unknown", evidence=["e9"]),
    state("k_imported", "Near-synonym choice", "fragile", origin="imported", evidence=["e7"]),
    state("k_unreadable", LONG_EN, "misconception", origin="legacy",
          provenance_unknown=True, evidence=None),
], summary="CET4 reading first: fill the synonym gaps.")

COURSE_LIST = {"courses": [
    {"course_id": "course_a", "title": "同义替换", "description": "", "status": "in_progress",
     "created_at": TODAY, "updated_at": TODAY,
     "counts": {"goals": 0, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0}},
]}

# The course record deliberately disagrees with the global profile for the same
# concept (`k_derived` is manual with 9 identifiers there): the course view must
# show its own record, never a backfilled one.
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


# ---------------------------------------------------------------------------
# Page plumbing
# ---------------------------------------------------------------------------

def install_routes(page: Page, holder: dict):
    """Answer every API call from fixtures, recording what was sent.

    The knowledge PATCH emulates the *server's* rule (`profile-updater.ts`): the
    stored record comes back with `origin: "manual"`. The frontend must not
    assume that itself, so B06 checks the label against this response rather
    than against anything the client could have derived.
    """
    requests: list[dict] = []
    holder.setdefault("requests", requests)
    holder.setdefault("knowledge_fail", False)

    def handler(route, request):
        path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
        body = None
        if request.post_data:
            try:
                body = json.loads(request.post_data)
            except json.JSONDecodeError:
                body = request.post_data
        entry = {"method": request.method, "path": path, "body": body}
        requests.append(entry)

        if path == "/api/learner/profile" and request.method == "GET":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["profile"]))

        if path.startswith("/api/learner/profile/goals/"):
            goal_id = path.rsplit("/", 1)[-1]
            stored = next((g for g in holder["profile"]["goals"] if g["goal_id"] == goal_id),
                          goal(goal_id, goal_id, 0.5))
            updated = {**stored, **(body or {}), "goal_id": goal_id}
            holder["profile"]["goals"] = [updated if g["goal_id"] == goal_id else g
                                          for g in holder["profile"]["goals"]]
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(updated))

        if path.startswith("/api/learner/profile/knowledge/"):
            concept_id = path.rsplit("/", 1)[-1]
            if holder["knowledge_fail"]:
                # A real 5xx: the client must keep the draft and the old source.
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "服务端暂时不可用"}))
            stored = next((s for s in holder["profile"]["knowledge_states"]
                           if s["concept_id"] == concept_id),
                          state(concept_id, concept_id))
            updated = {**stored, **(body or {}), "concept_id": concept_id,
                       "origin": "manual"}
            holder["profile"]["knowledge_states"] = [
                updated if s["concept_id"] == concept_id else s
                for s in holder["profile"]["knowledge_states"]]
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(updated))

        if path == "/api/courses":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(COURSE_LIST))
        if path == "/api/courses/course_a/learner":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(COURSE_A))
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
    expand_knowledge(page)
    return page, errors, holder, requests


def expand_knowledge(page: Page):
    """Open the 知识状态 section; above five rows it starts collapsed."""
    header = page.get_by_role("button", name=re.compile(r"^知识状态|^Knowledge"))
    if header.count() == 0:
        return
    if header.first.get_attribute("aria-expanded") == "false":
        header.first.click()
        page.wait_for_timeout(250)


def knowledge_section(page: Page):
    return page.locator("section", has=page.get_by_role("button", name=re.compile(r"^知识状态|^Knowledge")))


def goal_section(page: Page):
    return page.locator("section", has=page.get_by_role("button", name=re.compile(r"^学习目标|^Learning goals")))


def show_rows(page: Page, *names: str):
    """Frame the capture on the first named row, so it shows its own subject."""
    section = knowledge_section(page).first
    for name in names:
        if section.locator(".mla-knowledge-row", has_text=name).first.count() == 0:
            raise AssertionError(f"no knowledge row matching {name!r}")
    section.locator(".mla-knowledge-row", has_text=names[0]).first.evaluate(
        "el => el.scrollIntoView({block: 'start'})")
    page.wait_for_timeout(250)


def show_provenance(page: Page, name: str):
    """Frame the capture on one row's provenance block.

    `show_rows` anchors a row at the top of the viewport, which on a 640px-tall
    phone leaves the reading view's lower half — where the source and evidence
    lines sit — below the fold. A screenshot that cuts off the very lines the
    scenario is about proves nothing, so this scrolls the block itself to the
    middle of the viewport instead.
    """
    block = knowledge_section(page).locator(".mla-knowledge-row", has_text=name).first \
        .locator(".mla-provenance").first
    if block.count() == 0:
        raise AssertionError(f"no provenance block for {name!r}")
    block.evaluate("el => el.scrollIntoView({block: 'center'})")
    page.wait_for_timeout(250)


def open_row(page: Page, name: str):
    row = knowledge_section(page).locator(".mla-knowledge-row", has_text=name).first
    header = row.locator(".mla-knowledge-row__header")
    if header.get_attribute("aria-expanded") == "false":
        header.click()
        page.wait_for_timeout(250)
    return row


def expand_all_rows(page: Page):
    """Expand every row, so every record's reading view is measurable."""
    rows = knowledge_section(page).locator(".mla-knowledge-row")
    for index in range(rows.count()):
        header = rows.nth(index).locator(".mla-knowledge-row__header")
        if header.get_attribute("aria-expanded") == "false":
            header.click()
            page.wait_for_timeout(120)
    page.wait_for_timeout(250)


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------
#
# Same reasoning as P2-5-R1's probe: a box can have a non-zero width and still
# be cut in half by a clipping ancestor, so every part is checked against the
# real bounds of each ancestor that clips, its own text overflow, and the page's
# horizontal overflow. Vertical position is not asserted — the page scrolls.

PROBE = """() => {
  const round = (n) => Math.round(n * 10) / 10;
  const txt = (el) => (el ? (el.textContent || '').trim() : null);

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
    const cs = getComputedStyle(el);
    return {
      present: true,
      width: round(b.width), height: round(b.height),
      left: round(b.left), right: round(b.right),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      textOverflowX: el.scrollWidth > el.clientWidth + 1,
      text: txt(el),
      color: cs.color,
      clippedBy: clippersOf(el).filter((c) => b.left < c.left - 1 || b.right > c.right + 1),
    };
  };

  // The colour actually painted behind `el`, walking up past transparent boxes.
  const backgroundOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  const parseRgb = (value) => {
    const m = (value || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((v) => parseFloat(v.trim()));
    return {r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1};
  };

  // WCAG relative luminance + contrast ratio, so B05 states a number rather than
  // "it looked fine in the dark screenshot".
  const luminance = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const contrast = (fg, bg) => {
    const a = luminance(fg), b = luminance(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  const section = [...document.querySelectorAll('section')]
    .find((s) => /知识状态|Knowledge/.test(s.querySelector('h4')?.textContent || ''));
  const list = section ? section.querySelector('.mla-knowledge-list') : null;
  const rows = list ? [...list.querySelectorAll('.mla-knowledge-row')] : [];
  const doc = document.documentElement;

  const provenanceOf = (root) => {
    const block = root.querySelector('.mla-provenance');
    if (!block) return null;
    const origin = block.querySelector('.mla-provenance__value[data-provenance-origin]');
    const evidence = block.querySelector('[data-evidence-count]');
    const badge = block.querySelector('.mla-provenance__unknown');
    const hints = [...block.querySelectorAll('.mla-provenance__hint')].map((p) => txt(p));
    const bg = parseRgb(backgroundOf(origin || block));
    const fg = parseRgb(getComputedStyle(origin || block).color);
    return {
      text: txt(block),
      originLabel: txt(origin),
      originRaw: origin ? origin.getAttribute('data-provenance-origin') : null,
      evidenceText: txt(evidence),
      evidenceCount: evidence ? evidence.getAttribute('data-evidence-count') : null,
      unknownBadge: badge ? txt(badge) : null,
      hints,
      contrast: fg && bg ? contrast(fg, bg) : null,
      originBox: describe(origin),
      evidenceBox: describe(evidence),
      badgeBox: describe(badge),
    };
  };

  const goalSection = [...document.querySelectorAll('section')]
    .find((s) => /学习目标|Learning goals/.test(s.querySelector('h4')?.textContent || ''));
  const goalCards = goalSection
    ? [...goalSection.querySelectorAll('.rounded-xl')].filter((c) => c.querySelector('button'))
    : [];

  return {
    theme: doc.getAttribute('data-theme'),
    lang: doc.getAttribute('lang'),
    document: {scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
               overflowsHorizontally: doc.scrollWidth > doc.clientWidth + 1},
    list: list ? {width: round(list.getBoundingClientRect().width),
                  scrollWidth: list.scrollWidth, clientWidth: list.clientWidth,
                  overflowsHorizontally: list.scrollWidth > list.clientWidth + 1} : null,
    rows: rows.map((row) => {
      const nameEl = row.querySelector('.mla-knowledge-row__name');
      const header = row.querySelector('.mla-knowledge-row__header');
      const rb = row.getBoundingClientRect();
      const lb = list.getBoundingClientRect();
      return {
        name: txt(nameEl),
        expanded: header ? header.getAttribute('aria-expanded') : null,
        provenance: provenanceOf(row),
        // Only the reading view carries provenance; the collapsed header must not
        // have grown a fixed column for it (P2-5's container query relies on the
        // header's grid areas staying as they were).
        headerColumns: header ? getComputedStyle(header).gridTemplateColumns : null,
        row: {width: round(rb.width), left: round(rb.left), right: round(rb.right),
              scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
              overflowsContainer: row.scrollWidth > row.clientWidth + 1
                || rb.right > lb.right + 1 || rb.left < lb.left - 1,
              clippedBy: clippersOf(row).filter((c) => rb.left < c.left - 1 || rb.right > c.right + 1)},
        hasEditor: !!row.querySelector('textarea'),
      };
    }),
    goals: goalCards.map((card) => {
      const slider = card.querySelector('input[type=range]');
      // The priority line is its own <span> in the collapsed card (`· 优先级 …`)
      // and its own label line in the editor. Reading the card's whole text would
      // concatenate every field, so the line is taken from the leaf element.
      const leaves = [...card.querySelectorAll('span, div')].filter((n) => n.children.length === 0);
      const lineEl = leaves.find((n) => /优先级|Priority/.test(txt(n) || ''));
      return {
        text: card.innerText,
        sliderValue: slider ? slider.value : null,
        hasSlider: !!slider,
        // The collapsed card prefixes the line with a middot separator.
        priorityLine: lineEl ? (txt(lineEl) || '').replace(/^[·\\s]+/, '').trim() : null,
      };
    }),
  };
}"""


COURSE_PROBE = """() => {
  const round = (n) => Math.round(n * 10) / 10;
  const txt = (el) => (el ? (el.textContent || '').trim() : null);
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
    return {present: true, width: round(b.width), height: round(b.height),
            left: round(b.left), right: round(b.right),
            scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
            textOverflowX: el.scrollWidth > el.clientWidth + 1, text: txt(el),
            clippedBy: clippersOf(el).filter((c) => b.left < c.left - 1 || b.right > c.right + 1)};
  };
  const card = [...document.querySelectorAll('section')]
    .find((s) => s.querySelector('h2')?.textContent === '知识掌握');
  if (!card) return null;
  const list = card.querySelector('.mla-course-knowledge-list');
  const lb = list.getBoundingClientRect();
  const doc = document.documentElement;
  return {
    document: {scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
               overflowsHorizontally: doc.scrollWidth > doc.clientWidth + 1},
    list: {width: round(lb.width), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth,
           overflowsHorizontally: list.scrollWidth > list.clientWidth + 1},
    rows: [...card.querySelectorAll('.mla-course-knowledge-row')].map((row) => {
      const rb = row.getBoundingClientRect();
      const block = row.querySelector('.mla-provenance');
      const origin = block ? block.querySelector('[data-provenance-origin]') : null;
      const evidence = block ? block.querySelector('[data-evidence-count]') : null;
      const badge = block ? block.querySelector('.mla-provenance__unknown') : null;
      return {
        name: txt(row.querySelector('strong')),
        provenanceText: txt(block),
        originLabel: txt(origin),
        originRaw: origin ? origin.getAttribute('data-provenance-origin') : null,
        evidenceText: txt(evidence),
        evidenceCount: evidence ? evidence.getAttribute('data-evidence-count') : null,
        unknownBadge: badge ? txt(badge) : null,
        originBox: describe(origin),
        evidenceBox: describe(evidence),
        badgeBox: describe(badge),
        row: {width: round(rb.width), left: round(rb.left), right: round(rb.right),
              scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
              overflowsContainer: row.scrollWidth > row.clientWidth + 1
                || rb.right > lb.right + 1 || rb.left < lb.left - 1,
              clippedBy: clippersOf(row).filter((c) => rb.left < c.left - 1 || rb.right > c.right + 1)},
        columns: getComputedStyle(row).gridTemplateColumns,
        hasEditor: !!row.querySelector('input, textarea'),
      };
    }),
  };
}"""


def measure(page: Page) -> dict:
    return page.evaluate(PROBE)


def measure_course(page: Page) -> dict:
    return page.evaluate(COURSE_PROBE)


def ensure(condition, message):
    if not condition:
        raise AssertionError(message)


def check_provenance(data: dict, *, where: str):
    """Every rendered provenance block: bounds, clipping, and readable text."""
    ensure(data["rows"], f"{where}: no knowledge rows")
    ensure(not data["document"]["overflowsHorizontally"],
           f"{where}: page overflows horizontally "
           f"{data['document']['scrollWidth']}>{data['document']['clientWidth']}")
    if data["list"]:
        ensure(not data["list"]["overflowsHorizontally"],
               f"{where}: knowledge list overflows horizontally")
    seen = 0
    for row in data["rows"]:
        label = f"{where} / {(row['name'] or '')[:16]!r}"
        ensure(not row["row"]["overflowsContainer"], f"{label}: row wider than its list")
        ensure(not row["row"]["clippedBy"], f"{label}: row clipped {row['row']['clippedBy']}")
        prov = row["provenance"]
        if prov is None:
            # A collapsed row has no reading view, so it has no provenance — and
            # must not have grown a header column for one.
            ensure(row["expanded"] == "false", f"{label}: expanded row has no provenance block")
            continue
        seen += 1
        ensure(prov["originLabel"], f"{label}: no origin label")
        ensure(prov["evidenceText"], f"{label}: no evidence line")
        for part in ("originBox", "evidenceBox"):
            node = prov[part]
            ensure(node and node["present"], f"{label}: {part} missing")
            ensure(node["width"] > 0 and node["height"] > 0, f"{label}: {part} has no box")
            ensure(not node["clippedBy"], f"{label}: {part} clipped {node['clippedBy']}")
            ensure(not node["textOverflowX"], f"{label}: {part} text overflows its box")
        if prov["badgeBox"]:
            ensure(not prov["badgeBox"]["clippedBy"], f"{label}: unknown badge clipped")
    ensure(seen > 0, f"{where}: no provenance block was rendered at all")
    return seen


def row_by_name(data: dict, name: str) -> dict:
    for row in data["rows"]:
        if row["name"] == name:
            return row
    raise AssertionError(f"no row named {name!r} in {[r['name'] for r in data['rows']]}")


def requests_to(requests: list[dict], path_part: str, method: str = "PATCH") -> list[dict]:
    return [r for r in requests if r["method"] == method and path_part in r["path"]]


def record(page: Page, filename: str, *, scenario: str, viewport: str, theme: str,
           lang: str, errors: list[str], extra=None) -> dict:
    data = measure(page)
    data.update({"file": filename, "scenario": scenario, "viewport": viewport,
                 "theme": theme, "lang": lang, "pageErrors": list(errors)})
    if extra:
        data.update(extra)
    return data


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def b01_1440_all_courses(browser, out):
    """Every origin label, the unknown-source hint and the evidence counts."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    expand_all_rows(page)
    data = record(page, "p26-b01-1440-provenance.png", scenario="B01", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors)
    show_provenance(page, "同义替换")
    page.screenshot(path=str(ASSETS / "p26-b01-1440-provenance.png"), full_page=False)

    check_provenance(data, where="B01 1440")
    # Desktop keeps P2-5's five-column header: provenance lives in the body.
    ensure(len(data["rows"][0]["headerColumns"].split()) == 5,
           f"B01: header should keep five columns, got {data['rows'][0]['headerColumns']}")

    derived = row_by_name(data, "同义替换")["provenance"]
    ensure(derived["originLabel"] == "系统推导", f"B01: derived reads {derived['originLabel']!r}")
    ensure(derived["originRaw"] == "derived", f"B01: derived raw is {derived['originRaw']!r}")
    ensure(derived["evidenceCount"] == "2", f"B01: derived evidence {derived['evidenceCount']!r}")
    ensure(derived["evidenceText"] == "证据标识 2 个", f"B01: {derived['evidenceText']!r}")
    ensure(derived["unknownBadge"] is None, "B01: derived must not be flagged unknown")
    ensure(any("不代表证据质量" in h for h in derived["hints"]),
           f"B01: origin caveat missing, hints={derived['hints']}")
    ensure(any("不等于独立学习或练习次数" in h for h in derived["hints"]),
           f"B01: evidence caveat missing, hints={derived['hints']}")

    manual = row_by_name(data, "虚拟语气")["provenance"]
    ensure(manual["originLabel"] == "人工维护", f"B01: manual reads {manual['originLabel']!r}")
    ensure(manual["evidenceText"] == "证据标识 0 个",
           f"B01: an empty array is 0, got {manual['evidenceText']!r}")

    legacy = row_by_name(data, "连接词逻辑")["provenance"]
    ensure(legacy["originLabel"] == "历史记录", f"B01: legacy reads {legacy['originLabel']!r}")
    # A mirror, its source and a duplicate: 3 as stored, never deduplicated.
    ensure(legacy["evidenceCount"] == "3", f"B01: legacy count {legacy['evidenceCount']!r}")
    ensure(legacy["unknownBadge"] == "来源不明", "B01: legacy should carry the unknown badge")

    none = row_by_name(data, "长难句拆分")["provenance"]
    ensure(none["originLabel"] == "来源未标明",
           f"B01: a record with no origin reads {none['originLabel']!r}")
    ensure(none["originRaw"] == "", f"B01: absent origin raw {none['originRaw']!r}")
    ensure(none["unknownBadge"] is None,
           "B01: a missing provenance_unknown flag is not a claim of 'unknown'")

    imported = row_by_name(data, "近义词辨析")["provenance"]
    ensure(imported["originLabel"] == "来源未标明",
           f"B01: unrecognised origin reads {imported['originLabel']!r}")
    ensure(imported["originRaw"] == "imported", f"B01: raw origin kept as {imported['originRaw']!r}")
    ensure("系统推导" not in (imported["text"] or ""),
           "B01: an unrecognised origin must never be shown as 系统推导")

    unreadable = row_by_name(data, LONG_ZH)["provenance"]
    ensure(unreadable["evidenceText"] == "证据标识数量不可用",
           f"B01: unreadable evidence reads {unreadable['evidenceText']!r}")
    ensure(unreadable["evidenceCount"] == "unavailable",
           f"B01: unreadable count attribute {unreadable['evidenceCount']!r}")
    ensure("证据标识 0 个" not in (unreadable["text"] or ""),
           "B01: an unreadable field must never be shown as 0")
    # Both fields at once, and neither replaces the other.
    ensure(unreadable["originLabel"] == "历史记录" and unreadable["unknownBadge"] == "来源不明",
           "B01: origin and unknown must both show")

    # Nothing was written by a read-only scenario.
    ensure(not requests_to(requests, "/api/learner/profile/knowledge/"),
           "B01: a read-only view issued a PATCH")
    ensure(not errors, f"B01: page errors {errors}")
    out.append(data)
    page.close()


def b02_390_stacked(browser, out):
    """The same copy at phone width, where the row stacks."""
    page, errors, holder, requests = open_page(browser, width=390, height=844,
                                               profile_payload=PROFILE_ZH)
    expand_all_rows(page)
    data = record(page, "p26-b02-390-provenance.png", scenario="B02", viewport="390x844",
                  theme="light", lang="zh-CN", errors=errors)
    show_provenance(page, "连接词逻辑")
    page.screenshot(path=str(ASSETS / "p26-b02-390-provenance.png"), full_page=False)

    check_provenance(data, where="B02 390")
    # Stacked header: three grid areas, unchanged from P2-5.
    ensure(len(data["rows"][0]["headerColumns"].split()) == 3,
           f"B02: expected the stacked header, got {data['rows'][0]['headerColumns']}")
    legacy = row_by_name(data, "连接词逻辑")["provenance"]
    ensure(legacy["originLabel"] == "历史记录" and legacy["evidenceCount"] == "3",
           f"B02: legacy reads {legacy['originLabel']!r} / {legacy['evidenceCount']!r}")
    ensure(not errors, f"B02: page errors {errors}")
    out.append(data)
    page.close()


def b03_320_unknown_source(browser, out):
    """320px, Chinese: the unknown-source record, both fields visible."""
    page, errors, holder, requests = open_page(browser, width=320, height=640,
                                               profile_payload=PROFILE_ZH)
    open_row(page, "连接词逻辑")
    page.wait_for_timeout(200)
    data = record(page, "p26-b03-320-unknown.png", scenario="B03", viewport="320x640",
                  theme="light", lang="zh-CN", errors=errors)
    show_provenance(page, "连接词逻辑")
    page.screenshot(path=str(ASSETS / "p26-b03-320-unknown.png"), full_page=False)

    check_provenance(data, where="B03 320")
    legacy = row_by_name(data, "连接词逻辑")["provenance"]
    ensure(legacy["originLabel"] == "历史记录", f"B03: origin {legacy['originLabel']!r}")
    ensure(legacy["unknownBadge"] == "来源不明", "B03: unknown badge missing")
    ensure(any("服务端未能追溯" in h for h in legacy["hints"]),
           f"B03: unknown-source hint missing, hints={legacy['hints']}")
    ensure("来源不明" in (legacy["text"] or ""), "B03: badge text not in the block")
    # At 320px the whole block, including the badge, must fit without clipping.
    ensure(not legacy["badgeBox"]["clippedBy"], "B03: badge clipped at 320px")
    ensure(not errors, f"B03: page errors {errors}")
    out.append(data)
    page.close()


def b04_320_english(browser, out):
    """320px, English: the same six cases in English copy."""
    page, errors, holder, requests = open_page(browser, width=320, height=640,
                                               profile_payload=PROFILE_EN, lang="en")
    expand_all_rows(page)
    data = record(page, "p26-b04-320-en.png", scenario="B04", viewport="320x640",
                  theme="light", lang="en", errors=errors)
    show_provenance(page, "Substitute words")
    page.screenshot(path=str(ASSETS / "p26-b04-320-en.png"), full_page=False)

    check_provenance(data, where="B04 320-en")
    expect = {
        "Substitute words": ("System-derived", "2 evidence identifiers"),
        "Subjunctive mood": ("Manually maintained", "0 evidence identifiers"),
        "Connector logic": ("Legacy record", "3 evidence identifiers"),
        "Long sentence parsing": ("Source unspecified", "1 evidence identifier"),
        "Near-synonym choice": ("Source unspecified", "1 evidence identifier"),
    }
    for name, (origin, evidence) in expect.items():
        prov = row_by_name(data, name)["provenance"]
        ensure(prov["originLabel"] == origin,
               f"B04: {name!r} origin {prov['originLabel']!r} != {origin!r}")
        ensure(prov["evidenceText"] == evidence,
               f"B04: {name!r} evidence {prov['evidenceText']!r} != {evidence!r}")
    unreadable = row_by_name(data, LONG_EN)["provenance"]
    ensure(unreadable["evidenceText"] == "Evidence identifier count unavailable",
           f"B04: unreadable evidence reads {unreadable['evidenceText']!r}")
    ensure(row_by_name(data, "Connector logic")["provenance"]["unknownBadge"] == "Source unknown",
           "B04: English unknown badge missing")

    body = page.locator("body").inner_text()
    for leaked in ["系统推导", "人工维护", "历史记录", "来源未标明", "来源不明", "证据标识"]:
        ensure(leaked not in body, f"B04: Chinese {leaked!r} leaked into the English layout")
    ensure(not errors, f"B04: page errors {errors}")
    out.append(data)
    page.close()


def b05_dark(browser, out):
    """Dark theme: the block is legible, not merely present."""
    page, errors, holder, requests = open_page(browser, width=390, height=844,
                                               profile_payload=PROFILE_ZH, theme="dark")
    expand_all_rows(page)
    data = record(page, "p26-b05-dark.png", scenario="B05", viewport="390x844",
                  theme="dark", lang="zh-CN", errors=errors)
    show_provenance(page, "同义替换")
    page.screenshot(path=str(ASSETS / "p26-b05-dark.png"), full_page=False)

    ensure(data["theme"] == "dark", f"B05: theme is {data['theme']!r}, expected dark")
    check_provenance(data, where="B05 dark")
    ratios = {}
    for row in data["rows"]:
        prov = row["provenance"]
        if not prov:
            continue
        ensure(prov["contrast"] is not None, f"B05: no contrast for {row['name']!r}")
        ratios[row["name"]] = prov["contrast"]
        # 4.5:1 is WCAG AA for normal text; this is 12px body copy.
        ensure(prov["contrast"] >= 4.5,
               f"B05: {row['name']!r} provenance contrast {prov['contrast']} < 4.5")
    ensure(not errors, f"B05: page errors {errors}")
    data["contrastRatios"] = ratios
    out.append(data)
    page.close()


def b06_manual_save_success(browser, out):
    """Saving marks the record manual — because the server said so."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    row = open_row(page, "同义替换")
    before = measure(page)
    origin_before = row_by_name(before, "同义替换")["provenance"]["originRaw"]

    row.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(200)
    notice = row.locator("p", has_text=re.compile(r"保存修改后|manually maintained")).first
    notice_text = notice.text_content().strip() if notice.count() else None
    ensure(notice_text and "人工维护" in notice_text,
           f"B06: the editor must say the save marks it manual, got {notice_text!r}")

    textarea = row.locator("textarea").first
    textarea.fill("保存后的诊断")
    page.wait_for_timeout(120)
    row.get_by_role("button", name=re.compile(r"^保存$|^Save$")).first.click()
    page.wait_for_timeout(600)

    after = measure(page)
    origin_after = row_by_name(after, "同义替换")["provenance"]["originRaw"]
    label_after = row_by_name(after, "同义替换")["provenance"]["originLabel"]
    sent = requests_to(requests, "/api/learner/profile/knowledge/k_derived")
    page.screenshot(path=str(ASSETS / "p26-b06-manual-save.png"), full_page=False)

    ensure(len(sent) == 1, f"B06: expected exactly one PATCH, got {len(sent)}")
    ensure(sorted(sent[0]["body"].keys()) == ["diagnosis", "mastery", "next_actions"],
           f"B06: PATCH sent {sorted(sent[0]['body'].keys())}, expected the three editable fields")
    ensure("origin" not in sent[0]["body"],
           "B06: the client must not send an origin — the server owns it")
    ensure(origin_before == "derived", f"B06: origin before save was {origin_before!r}")
    ensure(origin_after == "manual", f"B06: origin after save is {origin_after!r}")
    ensure(label_after == "人工维护", f"B06: label after save is {label_after!r}")
    ensure(not row.locator("textarea").count(), "B06: the editor should close after a successful save")
    ensure(not errors, f"B06: page errors {errors}")
    out.append(record(page, "p26-b06-manual-save.png", scenario="B06", viewport="1440x900",
                      theme="light", lang="zh-CN", errors=errors,
                      extra={"originBefore": origin_before, "originAfter": origin_after,
                             "labelAfter": label_after, "editorNotice": notice_text,
                             "saveRequestCount": len(sent),
                             "saveRequestFields": sorted(sent[0]["body"].keys())}))
    page.close()


def b07_save_failure(browser, out):
    """A failed save keeps the draft and the original source."""
    page, errors, holder, requests = open_page(browser, width=390, height=844,
                                               profile_payload=PROFILE_ZH)
    holder["knowledge_fail"] = True
    row = open_row(page, "同义替换")
    before = measure(page)
    origin_before = row_by_name(before, "同义替换")["provenance"]["originRaw"]

    row.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(200)
    row.locator("textarea").first.fill("没保存的诊断")
    page.wait_for_timeout(120)
    row.get_by_role("button", name=re.compile(r"^保存$|^Save$")).first.click()
    page.wait_for_timeout(700)

    alert = row.locator('[role="alert"]')
    ensure(alert.count() == 1, "B07: no failure message after a rejected save")
    # Read it now: cancelling below unmounts the editor, and a locator cannot be
    # read after the element it points at is gone.
    alert_text = alert.text_content().strip()
    drafts = page.evaluate("[...document.querySelectorAll('textarea')].map((t) => t.value)")
    ensure("没保存的诊断" in " ".join(drafts), f"B07: draft lost, textareas={drafts}")
    sent = requests_to(requests, "/api/learner/profile/knowledge/k_derived")
    ensure(len(sent) == 1, f"B07: expected one PATCH, got {len(sent)}")

    # Still in the editor, so the reading view is not mounted; read the source
    # from the store the page is showing rather than from a block that is hidden.
    after = measure(page)
    ensure(row_by_name(after, "同义替换")["hasEditor"],
           "B07: the editor must stay open so the draft can be retried")
    page.screenshot(path=str(ASSETS / "p26-b07-save-failed.png"), full_page=False)

    # Cancel now: the row returns to the reading view, and the source must still
    # be the one the server last returned. Leaving a dirty draft asks through
    # `window.confirm`, which Playwright dismisses by default — so the dialog is
    # accepted explicitly here, otherwise the row would stay in the editor.
    page.on("dialog", lambda dialog: dialog.accept())
    row.get_by_role("button", name=re.compile(r"^取消$|^Cancel$")).first.click()
    page.wait_for_timeout(500)
    settled = measure(page)
    prov = row_by_name(settled, "同义替换")["provenance"]
    ensure(prov and prov["originRaw"] == origin_before,
           f"B07: origin changed to {prov and prov['originRaw']!r} after a failed save")
    ensure(prov["originLabel"] == "系统推导", f"B07: label is {prov['originLabel']!r}")
    ensure(not errors, f"B07: page errors {errors}")
    out.append(record(page, "p26-b07-save-failed.png", scenario="B07", viewport="390x844",
                      theme="light", lang="zh-CN", errors=errors,
                      extra={"originBefore": origin_before,
                             "originAfterFailure": prov["originRaw"],
                             "draftRetained": True,
                             "saveRequestCount": len(sent),
                             "alertText": alert_text}))
    page.close()


def b08_legacy_mirror(browser, out):
    """A legacy mirror and its source both count; the caveat says so."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    open_row(page, "连接词逻辑")
    page.wait_for_timeout(200)
    data = record(page, "p26-b08-legacy-mirror.png", scenario="B08", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors)
    show_provenance(page, "连接词逻辑")
    page.screenshot(path=str(ASSETS / "p26-b08-legacy-mirror.png"), full_page=False)

    check_provenance(data, where="B08")
    prov = row_by_name(data, "连接词逻辑")["provenance"]
    ensure(prov["originLabel"] == "历史记录", f"B08: origin {prov['originLabel']!r}")
    # ["legacy_1", "event_1", "legacy_1"] — the mirror, its source, and a repeat.
    ensure(prov["evidenceCount"] == "3", f"B08: count {prov['evidenceCount']!r}")
    ensure(prov["evidenceText"] == "证据标识 3 个", f"B08: {prov['evidenceText']!r}")
    ensure(any("旧版镜像记录可能重复计入" in h for h in prov["hints"]),
           f"B08: the mirror caveat is missing, hints={prov['hints']}")
    ensure(any("当前暂不提供证据明细" in h for h in prov["hints"]),
           f"B08: the 'no detail' note is missing, hints={prov['hints']}")
    # No identifier may be rendered: there is no detail view, and listing one
    # would imply an API that does not exist.
    ensure("legacy_1" not in (prov["text"] or ""), "B08: an evidence id leaked into the UI")
    ensure(not errors, f"B08: page errors {errors}")
    out.append(data)
    page.close()


def b09_goal_priority(browser, out):
    """An anomalous priority is shown raw and is not rewritten by the editor."""
    page, errors, holder, requests = open_page(browser, width=1440, height=900,
                                               profile_payload=PROFILE_ZH)
    section = goal_section(page)
    section.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    data = record(page, "p26-b09-priority.png", scenario="B09", viewport="1440x900",
                  theme="light", lang="zh-CN", errors=errors)
    page.screenshot(path=str(ASSETS / "p26-b09-priority.png"), full_page=False)

    anomaly_card = next(g for g in data["goals"] if g["priorityLine"] and "背完核心词表" in (g["text"] or ""))
    normal_card = next(g for g in data["goals"] if g["priorityLine"] and "读完 CET4" in (g["text"] or ""))
    # The collapsed line is 「· 优先级 <formatted value>」; the formatted value is
    # what must be the raw anomaly, not a percentage.
    ensure(anomaly_card["priorityLine"].endswith("优先级异常 · 原始值 3"),
           f"B09: anomaly line reads {anomaly_card['priorityLine']!r}")
    ensure("300%" not in (anomaly_card["text"] or ""), "B09: 300% must never be rendered")
    ensure("优先级 100%" not in (anomaly_card["text"] or ""),
           "B09: the anomaly must not be silently clamped to 100%")
    ensure(normal_card["priorityLine"].endswith("优先级 50%"),
           f"B09: the normal goal reads {normal_card['priorityLine']!r}")

    # Open the anomalous goal's editor: the thumb parks at the end of the track,
    # the label keeps saying 3, and the hint explains it.
    #
    # The card is held as an element handle, not a locator: opening the editor
    # replaces the card's *contents* with the form, so the title text the locator
    # matched on no longer exists. React reuses the same `div` node, which is why
    # the handle stays valid.
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

    # Title-only edit, then save: the untouched priority must go back as 3.
    card_handle.query_selector("input:not([type=range])").fill("改过标题的词表")
    page.wait_for_timeout(120)
    card_handle.query_selector("button:has-text('保存')").click()
    page.wait_for_timeout(600)
    goal_writes = requests_to(requests, "/api/learner/profile/goals/g_anomaly")
    ensure(len(goal_writes) == 1, f"B09: expected one goal PATCH, got {len(goal_writes)}")
    ensure(goal_writes[0]["body"]["priority"] == 3,
           f"B09: a title-only save wrote priority {goal_writes[0]['body']['priority']!r}, expected 3")

    after_save = measure(page)
    saved = next(g for g in after_save["goals"] if "改过标题的词表" in (g["text"] or ""))
    ensure(saved["priorityLine"].endswith("优先级异常 · 原始值 3"),
           f"B09: after saving the title, the line reads {saved['priorityLine']!r}")

    # Cancel path on the other goal: no request, no rewrite. Same element-handle
    # reason as above — the card's text is replaced by the form when it opens.
    normal = section.locator("div.rounded-xl", has_text="读完 CET4").first
    normal_handle = normal.element_handle()
    normal.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(200)
    normal_handle.query_selector("input:not([type=range])").fill("临时改的标题")
    page.wait_for_timeout(120)
    normal_handle.query_selector("button:has-text('取消')").click()
    page.wait_for_timeout(400)
    ensure(len(requests_to(requests, "/api/learner/profile/goals/g_normal")) == 0,
           "B09: cancelling issued a PATCH")
    after_cancel = measure(page)
    cancelled = next(g for g in after_cancel["goals"] if "读完 CET4" in (g["text"] or ""))
    ensure(cancelled["priorityLine"].endswith("优先级 50%"),
           f"B09: after cancel the line reads {cancelled['priorityLine']!r}")
    ensure("临时改的标题" not in (cancelled["text"] or ""), "B09: cancel kept the edited title")
    ensure(not errors, f"B09: page errors {errors}")

    out.append({**record(page, "p26-b09-priority.png", scenario="B09", viewport="1440x900",
                         theme="light", lang="zh-CN", errors=errors),
                "anomalyLine": anomaly_card["priorityLine"],
                "normalLine": normal_card["priorityLine"],
                "sliderValueForAnomaly": slider_value,
                "titleOnlySavePriority": goal_writes[0]["body"]["priority"],
                "lineAfterTitleSave": saved["priorityLine"],
                "lineAfterCancel": cancelled["priorityLine"],
                "goalSaveRequests": len(requests_to(requests, "/api/learner/profile/goals/"))})
    page.close()


def b10_course_320(browser, out):
    """The course view reads its own record, stays read-only, fits 320px."""
    page, errors, holder, requests = open_page(browser, width=320, height=640,
                                               profile_payload=PROFILE_ZH)
    page.get_by_label("选择学习档案范围").focus()
    page.keyboard.press("Enter")
    page.get_by_role("option", name="同义替换").click()
    page.get_by_role("heading", name="知识掌握").wait_for(state="visible", timeout=15000)
    page.wait_for_timeout(400)
    card = page.locator("section", has=page.get_by_role("heading", name="知识掌握"))
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    course = measure_course(page)
    page.screenshot(path=str(ASSETS / "p26-b10-320-course.png"), full_page=False)

    ensure(course is not None, "B10: the course knowledge card did not render")
    ensure(len(course["rows"]) == 4, f"B10: expected 4 course rows, got {len(course['rows'])}")
    ensure(not course["document"]["overflowsHorizontally"], "B10: page overflows horizontally")
    ensure(not course["list"]["overflowsHorizontally"], "B10: course list overflows horizontally")

    for row in course["rows"]:
        where = f"B10 / {(row['name'] or '')[:14]!r}"
        ensure(not row["row"]["overflowsContainer"], f"{where}: row wider than the list")
        ensure(not row["row"]["clippedBy"], f"{where}: row clipped {row['row']['clippedBy']}")
        ensure(not row["hasEditor"], f"{where}: the course view is not read-only")
        ensure(len(row["columns"].split()) == 1,
               f"{where}: expected a single column at 320px, got {row['columns']}")
        ensure(row["originLabel"], f"{where}: no origin label")
        for part in ("originBox", "evidenceBox"):
            node = row[part]
            ensure(node and node["width"] > 0, f"{where}: {part} has no box")
            ensure(not node["clippedBy"], f"{where}: {part} clipped {node['clippedBy']}")
            ensure(not node["textOverflowX"], f"{where}: {part} text overflows its box")

    derived = next(r for r in course["rows"] if r["name"] == "同义替换")
    ensure(derived["originRaw"] == "derived", f"B10: course origin {derived['originRaw']!r}")
    ensure(derived["evidenceCount"] == "1", f"B10: course count {derived['evidenceCount']!r}")
    # The global profile says manual with 9 identifiers for this same concept.
    ensure("人工维护" not in (derived["provenanceText"] or ""),
           "B10: the global profile's origin leaked into the course row")
    ensure("证据标识 9 个" not in (derived["provenanceText"] or ""),
           "B10: the global profile's evidence count leaked into the course row")
    legacy = next(r for r in course["rows"] if r["name"] == "连接词逻辑")
    ensure(legacy["unknownBadge"] == "来源不明" and legacy["originLabel"] == "历史记录",
           f"B10: legacy row reads {legacy['provenanceText']!r}")
    unreadable = next(r for r in course["rows"] if r["name"] == LONG_ZH)
    ensure(unreadable["evidenceText"] == "证据标识数量不可用",
           f"B10: unreadable evidence reads {unreadable['evidenceText']!r}")
    ensure(not requests_to(requests, "/api/learner/profile/knowledge/"),
           "B10: the read-only course view issued a PATCH")
    ensure(not errors, f"B10: page errors {errors}")
    out.append({"scenario": "B10", "viewport": "320x640", "theme": "light", "lang": "zh-CN",
                "file": "p26-b10-320-course.png", "pageErrors": list(errors), **course})
    page.close()


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    out: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            b01_1440_all_courses(browser, out)
            b02_390_stacked(browser, out)
            b03_320_unknown_source(browser, out)
            b04_320_english(browser, out)
            b05_dark(browser, out)
            b06_manual_save_success(browser, out)
            b07_save_failure(browser, out)
            b08_legacy_mirror(browser, out)
            b09_goal_priority(browser, out)
            b10_course_320(browser, out)

            METRICS.write_text(json.dumps({
                "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
                "base": BASE,
                "note": "B01-B10 for E4.9i-P2-6. P2-5 / P2-5-R1 evidence lives in P2-5-assets/ and is untouched.",
                "scenarios": out,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(out)} scenarios -> {METRICS}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
