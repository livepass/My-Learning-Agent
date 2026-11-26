"""E4.9i-P2-5 browser acceptance: responsive knowledge rows on phones.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_5.py

Every /api request is answered by `page.route` fixtures defined here, so no real
learner data is read or written and no backend is needed. Screenshots and metrics
go to `P2-5-assets/`; the P2-4 evidence is not touched.

What this proves, which jsdom cannot: real layout. Each scenario measures the
rendered boxes (row, identity, progress, percentage, badge, date) at seven
viewports and asserts the properties the task book names — the badge stays
visible, the bar keeps a usable width, the percentage keeps its full text, long
names wrap instead of being clipped, and no page-level horizontal overflow
appears.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "http://127.0.0.1:5193/?page=profile"
API_ROUTE = re.compile(r"^http://127\.0\.0\.1:5193/api/")
PHASE = Path(__file__).resolve().parents[1]
ASSETS = PHASE / "P2-5-assets"
METRICS = ASSETS / "p25-browser-metrics.json"

TODAY = "2026-11-24T08:00:00.000Z"

# The seven viewports the task book requires.
VIEWPORTS = {
    "1440": (1440, 900),
    "1024": (1024, 768),
    "768": (768, 1024),
    "430": (430, 932),
    "390": (390, 844),
    "375": (375, 812),
    "320": (320, 640),
}

# Where the row switches from one line to a stacked layout. Container queries
# answer to the list's own width, so this is not a viewport comparison.
STACKED_MAX_VIEWPORT = 430


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def state(concept_id, name, label, *, domain="cet4", mastery=0.5, diagnosis="诊断文本。",
          due=None, evidence=None, next_actions=None):
    return {
        "concept_id": concept_id,
        "concept_name": name,
        "domain": domain,
        "state_label": label,
        "mastery": mastery,
        "confidence": 0.5,
        "stability": 0.5,
        "evidence_ids": evidence if evidence is not None else ["e1"],
        "diagnosis": diagnosis,
        "next_actions": next_actions or [],
        "review_due_at": due,
    }


def profile(states, *, misconceptions=None, summary="以 CET4 阅读为主线：先补同义替换。"):
    return {
        "learner_id": "default",
        "version": 7,
        "updated_at": TODAY,
        "goals": [],
        "knowledge_states": states,
        "misconceptions": misconceptions or [],
        "preferences": {"explanation_style": [], "practice_style": [],
                        "feedback_tone": [], "avoid": []},
        "profile_summary": summary,
    }


LONG_ZH = "这是一个非常非常长的中文知识点名称用来测试换行行为是否正常"
LONG_EN = "A very long English concept name that should wrap instead of being clipped"

# Every state label once, plus the two long names, a 0% and a 100% row.
SCENARIO = profile([
    state("c_short", "虚拟语气", "learning", mastery=0.5),
    state("c_long_zh", LONG_ZH, "fragile", mastery=0.5),
    state("c_long_en", LONG_EN, "stable", mastery=0.5),
    state("c_zero", "长难句拆分", "unknown", mastery=0.0),
    state("c_full", "细节匹配", "stable", mastery=1.0),
    state("c_review", "连接词逻辑", "review_due", due="2026-12-01T00:00:00.000Z", mastery=0.5),
    state("c_misc", "近义词辨析", "misconception", mastery=0.5),
])

# English copy: the task book requires both languages, and the stacked layout
# shows the date *label*, which must not fall back to Chinese punctuation.
LONG_EN_EN = "A very long English concept name that should wrap instead of being clipped"
SCENARIO_EN = profile([
    state("e_short", "Subjunctive mood", "learning"),
    state("e_long", LONG_EN_EN, "stable"),
    state("e_review", "Connector logic", "review_due", due="2026-12-01T00:00:00.000Z"),
    state("e_zero", "Long sentence parsing", "unknown", mastery=0.0),
], summary="CET4 reading first: fill the synonym gaps.")

# One short name per state label, so all six badges fit in one phone screen and
# the all-badges screenshot actually shows what the assertion counts. The mixed
# SCENARIO above carries the same six labels but its two long names push the
# last rows below the fold.
SCENARIO_BADGES = profile([
    state("b_learning", "虚拟语气", "learning"),
    state("b_fragile", "定语从句", "fragile"),
    state("b_review", "连接词逻辑", "review_due", due="2026-12-01T00:00:00.000Z"),
    state("b_misc", "近义词辨析", "misconception"),
    state("b_stable", "细节匹配", "stable"),
    state("b_unknown", "长难句拆分", "unknown", mastery=0.0),
])

# The same six states with English names, for R03 (320px, English UI). The badge
# *labels* come from the locale; the concept names must be English too, or the
# scenario would test Chinese text inside an English layout.
SCENARIO_BADGES_EN = profile([
    state("b_learning", "Subjunctive mood", "learning"),
    state("b_fragile", "Relative clauses", "fragile"),
    state("b_review", "Connector logic", "review_due", due="2026-12-01T00:00:00.000Z"),
    state("b_misc", "Near-synonym choice", "misconception"),
    state("b_stable", "Detail matching", "stable"),
    state("b_unknown", "Long sentence parsing", "unknown", mastery=0.0),
], summary="CET4 reading first: fill the synonym gaps.")

COURSE_LIST = {"courses": [
    {"course_id": "course_a", "title": "同义替换", "description": "", "status": "in_progress",
     "created_at": TODAY, "updated_at": TODAY,
     "counts": {"goals": 0, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0}},
]}

COURSE_A = {
    "course": {"course_id": "course_a", "title": "同义替换", "description": "",
               "status": "in_progress", "created_at": TODAY, "updated_at": TODAY},
    "goals": [],
    "knowledge_states": [
        state("a_short", "虚拟语气", "learning"),
        state("a_long_zh", LONG_ZH, "learning"),
        state("a_long_en", LONG_EN, "stable"),
        state("a_review", "连接词逻辑", "review_due", due="2026-12-01T00:00:00.000Z"),
    ],
    "preferences": {"explanation_style": [], "practice_style": [], "feedback_tone": [], "avoid": []},
    "unclassified": {"knowledge_states": 0, "goals": 0},
}


# ---------------------------------------------------------------------------
# Page plumbing
# ---------------------------------------------------------------------------

def install_routes(page: Page, *, profile_payload, courses=None, live=None):
    """Answer every API call from fixtures and record what was requested."""
    calls: list[str] = []
    holder = live if live is not None else {"profile": profile_payload}

    def handler(route, request):
        path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
        calls.append(f"{request.method} {path}")
        if path == "/api/learner/profile" and request.method == "GET":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["profile"]))
        if path == "/api/learner/profile" and request.method == "PATCH":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(holder["profile"]))
        if path.startswith("/api/learner/profile/knowledge/"):
            concept_id = path.rsplit("/", 1)[-1]
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
        if path == "/api/courses/daily":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"date": "2026-11-24", "daily_minutes": 30,
                                                  "courses": [], "notes": []}))
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

    page.route(API_ROUTE, handler)
    return calls


def open_page(browser, *, width, height, profile_payload, lang="zh-CN", theme="light",
              courses=None, live=None):
    """Open the profile page with fixtures.

    `theme` is a parameter (E4.9i-P2-5-R1, F02): the P2-5 suite pinned every
    scenario to light, so a dark-theme regression in the row could not have been
    seen. It is written to `localStorage` before the app boots, which is the same
    key `theme-store.ts` reads, and the store applies it before first render.
    """
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(
        f"localStorage.setItem('inno.theme', {json.dumps(theme)});"
        f"localStorage.setItem('inno.locale', {json.dumps(lang)});"
    )
    calls = install_routes(page, profile_payload=profile_payload, courses=courses, live=live)
    page.goto(BASE, wait_until="networkidle")
    page.locator(".mla-profile-container").wait_for(state="visible", timeout=15000)
    expand_knowledge(page)
    return page, errors, calls


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


def scroll_to_section(page: Page):
    knowledge_section(page).first.scroll_into_view_if_needed()
    page.wait_for_timeout(200)


def show_rows(page: Page, *names: str):
    """Scroll so the named rows are on screen, first name at the top.

    A screenshot only evidences a scenario if it *shows* that scenario's rows.
    Before this, the long-name and all-badges captures were taken after
    `scroll_to_section`, which parks at the top of the card — so four files were
    byte-identical to the plain 390px capture and proved nothing about their own
    subject even though the measurements did cover every row.

    Anchoring on the *first* row (`block: 'start'`) keeps the whole range below
    it visible; anchoring on the last instead pushes the first rows off the top,
    which is how the all-badges capture lost its 待复习 row.
    """
    section = knowledge_section(page).first
    for name in names:
        row = section.locator(".mla-knowledge-row", has_text=name).first
        if row.count() == 0:
            raise AssertionError(f"no knowledge row matching {name!r}")
    section.locator(".mla-knowledge-row", has_text=names[0]).first.evaluate(
        "el => el.scrollIntoView({block: 'start'})")
    page.wait_for_timeout(250)


def open_editor(page: Page, name: str, text: str):
    """Open one row's editor and type into that row's diagnosis field."""
    section = knowledge_section(page)
    row = section.locator("button[aria-expanded]", has_text=name).first
    row.click()
    page.wait_for_timeout(150)
    wrapper = row.locator("xpath=..")
    wrapper.get_by_role("button", name=re.compile(r"^编辑$|^Edit$")).first.click()
    page.wait_for_timeout(150)
    wrapper.locator("textarea").first.fill(text)
    page.wait_for_timeout(150)


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------

MEASURE = """() => {
  const txt = (node) => (node ? node.textContent.trim() : null);
  const W = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
  const section = [...document.querySelectorAll('section')]
    .find((s) => /知识状态|Knowledge/.test(s.querySelector('h4')?.textContent || ''));
  const list = section ? section.querySelector('.mla-knowledge-list') : null;
  const rows = list ? [...list.querySelectorAll('.mla-knowledge-row')] : [];
  const rowsOut = rows.map((row) => {
    const header = row.querySelector('.mla-knowledge-row__header');
    const name = row.querySelector('.mla-knowledge-row__name');
    const badge = row.querySelector('.mla-knowledge-row__badge');
    const prog = row.querySelector('.mla-knowledge-row__progress');
    const pct = row.querySelector('.mla-knowledge-row__percentage');
    const date = row.querySelector('.mla-knowledge-row__date');
    const toggle = row.querySelector('.mla-knowledge-row__toggle');
    const r = row.getBoundingClientRect();
    const nb = name ? name.getBoundingClientRect() : null;
    const bb = badge ? badge.getBoundingClientRect() : null;
    // Does the name's box collide with the badge's box?
    const overlap = nb && bb
      ? !(nb.right <= bb.left + 1 || bb.right <= nb.left + 1 ||
          nb.bottom <= bb.top + 1 || bb.bottom <= nb.top + 1)
      : null;
    return {
      name: txt(name),
      rowWidth: W(row), rowScrollWidth: row.scrollWidth, rowClientWidth: row.clientWidth,
      rowOverflow: row.scrollWidth > row.clientWidth + 1,
      identityWidth: W(row.querySelector('.mla-knowledge-row__identity')),
      nameWidth: W(name), nameScrollWidth: name ? name.scrollWidth : null,
      nameClientWidth: name ? name.clientWidth : null,
      // Clipped = the text needs more width than the box gives it AND the box
      // is not wrapping (a wrapping box grows in height instead).
      nameClipped: name
        ? name.scrollWidth > name.clientWidth + 1 && name.clientHeight <= 24
        : null,
      nameHeight: name ? Math.round(nb.height) : null,
      progressWidth: W(prog),
      percentageWidth: W(pct), percentageText: txt(pct),
      percentageScrollWidth: pct ? pct.scrollWidth : null,
      badgeWidth: W(badge), badgeText: txt(badge),
      badgeVisible: badge ? bb.width > 0 && bb.height > 0 : false,
      dateWidth: W(date), dateText: txt(date),
      toggleVisible: toggle ? toggle.getBoundingClientRect().width > 0 : false,
      nameBadgeOverlap: overlap,
      headerColumns: header ? getComputedStyle(header).gridTemplateColumns : null,
    };
  });
  const doc = document.documentElement;
  return {
    containerWidth: W(list),
    rows: rowsOut,
    rowCount: rowsOut.length,
    documentScrollWidth: doc.scrollWidth,
    documentClientWidth: doc.clientWidth,
    documentOverflow: doc.scrollWidth > doc.clientWidth + 1,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 1,
  };
}"""


def measure(page: Page) -> dict:
    return page.evaluate(MEASURE)


# ---------------------------------------------------------------------------
# E4.9i-P2-5-R1 (F03): real visibility, not `width > 0`
# ---------------------------------------------------------------------------
#
# The P2-5 checks treated `getBoundingClientRect().width > 0` as "visible". That
# is also true for an element laid out inside a clipped ancestor: a badge can be
# 52px wide and still be cut in half by an `overflow: hidden` parent. This probe
# answers the questions the task book actually asks:
#
#   * what are the element's real bounds, and the row's?
#   * which ancestors clip, and is the element inside their visible box?
#   * does the element's own text overflow its box?
#   * do two elements that must not touch overlap?
#   * is the row wider than its container (horizontal overflow)?
#   * is the page wider than the viewport?
#
# Scrolling is handled separately and honestly: content below the fold is
# *reachable*, not clipped, so vertical visibility is not asserted here. Only the
# horizontal axis is treated as clipping, because that is the one the user
# cannot scroll away.

VISIBILITY = """() => {
  const round = (n) => Math.round(n * 10) / 10;
  const section = [...document.querySelectorAll('section')]
    .find((s) => /知识状态|Knowledge/.test(s.querySelector('h4')?.textContent || ''));
  const list = section ? section.querySelector('.mla-knowledge-list') : null;

  // Every ancestor that can clip a descendant's painted box.
  const clippersOf = (el) => {
    const out = [];
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const cs = getComputedStyle(node);
      const clipsX = cs.overflowX !== 'visible';
      const clipsY = cs.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const box = node.getBoundingClientRect();
      out.push({
        tag: node.tagName,
        cls: (node.className || '').toString().slice(0, 60),
        overflowX: cs.overflowX, overflowY: cs.overflowY,
        left: round(box.left), right: round(box.right),
        top: round(box.top), bottom: round(box.bottom),
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      });
    }
    return out;
  };

  /**
   * Is `el` inside every horizontal clip box above it? Vertical is reported but
   * not required (the page scrolls vertically; a row below the fold is fine).
   * A clip box whose own content is scrolled is compared against its padding
   * box, which is what the user can actually see.
   */
  const clippedHorizontally = (el) => {
    const box = el.getBoundingClientRect();
    const offenders = [];
    for (const clip of clippersOf(el)) {
      if (clip.overflowX === 'visible') continue;
      // A clipping ancestor with no width cannot clip anything meaningfully.
      if (clip.right - clip.left <= 0) continue;
      if (box.left < clip.left - 1 || box.right > clip.right + 1) {
        offenders.push({ ...clip, elLeft: round(box.left), elRight: round(box.right) });
      }
    }
    return offenders;
  };

  const describe = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      present: true,
      width: round(b.width), height: round(b.height),
      left: round(b.left), right: round(b.right), top: round(b.top), bottom: round(b.bottom),
      // scrollWidth > clientWidth means the content does not fit its own box.
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      textOverflowX: el.scrollWidth > el.clientWidth + 1,
      textOverflowY: el.scrollHeight > el.clientHeight + 1,
      whiteSpace: cs.whiteSpace, overflowX: cs.overflowX, textOverflow: cs.textOverflow,
      text: (el.textContent || '').trim(),
      clippedBy: clippedHorizontally(el),
    };
  };

  const overlaps = (a, b) => {
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (ra.width === 0 || rb.width === 0) return false;
    return !(ra.right <= rb.left + 1 || rb.right <= ra.left + 1 ||
             ra.bottom <= rb.top + 1 || rb.bottom <= ra.top + 1);
  };

  const rows = list ? [...list.querySelectorAll('.mla-knowledge-row')] : [];
  const doc = document.documentElement;

  return {
    theme: doc.getAttribute('data-theme'),
    rows: rows.map((row) => {
      const header = row.querySelector('.mla-knowledge-row__header');
      const name = row.querySelector('.mla-knowledge-row__name');
      const badge = row.querySelector('.mla-knowledge-row__badge');
      const progress = row.querySelector('.mla-knowledge-row__progress');
      const bar = row.querySelector('.mla-knowledge-row__bar');
      const pct = row.querySelector('.mla-knowledge-row__percentage');
      const date = row.querySelector('.mla-knowledge-row__date');
      const toggle = row.querySelector('.mla-knowledge-row__toggle');
      const fullName = row.querySelector('.mla-knowledge-row__full-name');
      const rowBox = row.getBoundingClientRect();
      const container = list.getBoundingClientRect();
      return {
        name: name ? (name.textContent || '').trim() : null,
        expanded: header ? header.getAttribute('aria-expanded') : null,
        row: {
          width: round(rowBox.width), height: round(rowBox.height),
          left: round(rowBox.left), right: round(rowBox.right),
          scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
          // The row must not be wider than the list that holds it.
          overflowsContainer: row.scrollWidth > row.clientWidth + 1
            || rowBox.right > container.right + 1 || rowBox.left < container.left - 1,
          clippedBy: clippedHorizontally(row),
        },
        name_box: describe(name),
        badge: describe(badge),
        progress: describe(progress),
        bar: bar ? {
          width: round(bar.getBoundingClientRect().width),
          // The filled bar must not exceed the track it sits in.
          withinTrack: progress
            ? bar.getBoundingClientRect().right <= progress.getBoundingClientRect().right + 1
            : null,
        } : null,
        percentage: describe(pct),
        date: describe(date),
        toggle: describe(toggle),
        fullName: describe(fullName),
        overlaps: {
          nameBadge: overlaps(name, badge),
          badgeToggle: overlaps(badge, toggle),
          nameToggle: overlaps(name, toggle),
          pctBadge: overlaps(pct, badge),
          dateToggle: overlaps(date, toggle),
          progressPct: overlaps(progress, pct),
        },
      };
    }),
    document: {
      scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      overflowsHorizontally: doc.scrollWidth > doc.clientWidth + 1,
    },
    list: list ? {
      width: round(list.getBoundingClientRect().width),
      scrollWidth: list.scrollWidth, clientWidth: list.clientWidth,
      overflowsHorizontally: list.scrollWidth > list.clientWidth + 1,
    } : null,
  };
}"""


def inspect(page: Page) -> dict:
    return page.evaluate(VISIBILITY)


def check_visible(data: dict, *, where: str, require_full_name: bool = False):
    """The F03 invariants: real bounds, real clipping, real overlap.

    `where` prefixes every message so a failure names its scenario.
    """
    ensure(data["rows"], f"{where}: no knowledge rows")
    ensure(not data["document"]["overflowsHorizontally"],
           f"{where}: page overflows horizontally "
           f"{data['document']['scrollWidth']}>{data['document']['clientWidth']}")
    ensure(not data["list"]["overflowsHorizontally"],
           f"{where}: knowledge list overflows horizontally "
           f"{data['list']['scrollWidth']}>{data['list']['clientWidth']}")

    for row in data["rows"]:
        label = f"{where} / {(row['name'] or '')[:16]!r}"
        ensure(not row["row"]["overflowsContainer"], f"{label}: row wider than its list")
        ensure(not row["row"]["clippedBy"], f"{label}: row clipped horizontally {row['row']['clippedBy']}")

        # Every part that must stay visible: present, non-zero, inside its clip
        # boxes, and not overflowing its own box horizontally.
        for part in ("badge", "progress", "percentage", "toggle"):
            node = row[part]
            ensure(node and node.get("present"), f"{label}: {part} missing")
            ensure(node["width"] > 0 and node["height"] > 0, f"{label}: {part} has no box")
            ensure(not node["clippedBy"], f"{label}: {part} clipped by an ancestor {node['clippedBy']}")
            ensure(not node["textOverflowX"], f"{label}: {part} text overflows its box "
                   f"{node['scrollWidth']}>{node['clientWidth']}")
            if part == "percentage":
                ensure(node["text"].endswith("%"), f"{label}: percentage text {node['text']!r}")

        # The badge carries text and must show all of it.
        ensure(row["badge"]["text"], f"{label}: badge empty")

        # A date, when rendered, is visible and not clipped.
        if row["date"] and row["date"].get("present"):
            ensure(not row["date"]["clippedBy"], f"{label}: date clipped {row['date']['clippedBy']}")
            ensure(not row["date"]["textOverflowX"], f"{label}: date text overflows its box")

        # The filled bar stays inside its track.
        ensure(row["bar"] and row["bar"]["width"] >= 0, f"{label}: bar missing")
        ensure(row["bar"]["withinTrack"] is not False, f"{label}: bar exceeds its track")

        # Nothing that must be readable may collide with something else.
        for pair, collides in row["overlaps"].items():
            ensure(collides is not True, f"{label}: {pair} overlap")

        # Only a row that is actually expanded has a reading view, so the full
        # name is required of *those* rows — not of every row on the page.
        if require_full_name and row["expanded"] == "true":
            full = row["fullName"]
            ensure(full and full.get("present"), f"{label}: full name missing while expanded")
            ensure(not full["clippedBy"], f"{label}: full name clipped {full['clippedBy']}")
            ensure(not full["textOverflowX"], f"{label}: full name text overflows its box")
            ensure(row["name"] and row["name"] in full["text"],
                   f"{label}: full name {full['text']!r} does not contain {row['name']!r}")


def ensure(condition, message):
    if not condition:
        raise AssertionError(message)


def check_rows(data: dict, *, viewport: str, require_stacked: bool | None):
    """The invariants every viewport must hold, whatever its width."""
    ensure(data["rowCount"] > 0, f"{viewport}: no knowledge rows rendered")
    ensure(not data["documentOverflow"],
           f"{viewport}: document overflow {data['documentScrollWidth']} > {data['documentClientWidth']}")
    ensure(not data["bodyOverflow"], f"{viewport}: body overflow")
    for row in data["rows"]:
        where = f"{viewport} / {row['name'][:18]!r}"
        ensure(not row["rowOverflow"], f"{where}: row overflows {row['rowScrollWidth']}>{row['rowClientWidth']}")
        ensure(row["badgeVisible"], f"{where}: badge not visible")
        ensure(row["badgeWidth"] and row["badgeWidth"] > 0, f"{where}: badge width 0")
        ensure(row["badgeText"], f"{where}: badge empty")
        ensure(row["progressWidth"] and row["progressWidth"] > 0, f"{where}: progress width 0")
        ensure(row["percentageWidth"] and row["percentageWidth"] > 0, f"{where}: percentage width 0")
        ensure(row["percentageText"] and row["percentageText"].endswith("%"),
               f"{where}: percentage text {row['percentageText']!r}")
        # "0%" is legitimately ~18px wide, so the invariant is not a fixed
        # minimum: it is that the box fits its own text without clipping.
        ensure(row["percentageScrollWidth"] <= row["percentageWidth"] + 1,
               f"{where}: percentage clipped "
               f"{row['percentageScrollWidth']}>{row['percentageWidth']}")
        ensure(row["toggleVisible"], f"{where}: chevron hidden")
        ensure(row["nameBadgeOverlap"] is False, f"{where}: name overlaps the badge")
        if require_stacked:
            # Stacked: the identity occupies its own line, so the name is free to
            # grow taller than one line and must not be clipped.
            ensure(row["nameClipped"] is False, f"{where}: name clipped while stacked")


def record(page: Page, filename: str, *, viewport: str, scenario: str, extra=None) -> dict:
    data = measure(page)
    data.update({"file": filename, "viewport": viewport, "scenario": scenario})
    if extra:
        data.update(extra)
    return data


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    measurements: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            # 1. The viewport matrix ------------------------------------------
            for key, (width, height) in VIEWPORTS.items():
                page, errors, calls = open_page(browser, width=width, height=height,
                                                profile_payload=SCENARIO)
                scroll_to_section(page)
                filename = f"p25-desktop-{key}.png" if width >= 1024 else f"p25-mobile-{key}.png"
                if width == 768:
                    filename = "p25-tablet-768.png"
                data = record(page, filename, viewport=f"{width}x{height}", scenario="viewport-matrix")
                page.screenshot(path=str(ASSETS / filename), full_page=False)
                check_rows(data, viewport=key, require_stacked=width <= STACKED_MAX_VIEWPORT)
                # Desktop keeps the one-line arrangement; phones stack.
                if width >= 1024:
                    ensure(len(data["rows"][0]["headerColumns"].split()) == 5,
                           f"{key}: desktop should keep five columns, got {data['rows'][0]['headerColumns']}")
                if width <= STACKED_MAX_VIEWPORT:
                    ensure(len(data["rows"][0]["headerColumns"].split()) == 3,
                           f"{key}: expected the stacked grid, got {data['rows'][0]['headerColumns']}")
                ensure(not errors, f"{key}: page errors {errors}")
                measurements.append(data)
                page.close()

            # 2. Long names ----------------------------------------------------
            page, errors, calls = open_page(browser, width=390, height=844, profile_payload=SCENARIO)
            scroll_to_section(page)
            # The two long rows are second and third; scroll so both are on screen.
            show_rows(page, LONG_ZH)
            data = record(page, "p25-mobile-long-zh.png", viewport="390x844", scenario="long-names")
            page.screenshot(path=str(ASSETS / "p25-mobile-long-zh.png"), full_page=False)
            zh = next(r for r in data["rows"] if r["name"] == LONG_ZH)
            en = next(r for r in data["rows"] if r["name"] == LONG_EN)
            ensure(zh["nameClipped"] is False, "long Chinese name is clipped")
            ensure(en["nameClipped"] is False, "long English name is clipped")
            ensure(zh["nameHeight"] > 20, f"long Chinese name did not wrap (height {zh['nameHeight']})")
            ensure(en["nameHeight"] > 20, f"long English name did not wrap (height {en['nameHeight']})")
            ensure(not errors, f"long names: errors {errors}")
            measurements.append(data)
            page.close()

            page, errors, calls = open_page(browser, width=390, height=844, profile_payload=SCENARIO)
            scroll_to_section(page)
            # Anchor the English row at the top of the viewport, so this capture is
            # framed on it rather than repeating the long-zh framing above it.
            show_rows(page, LONG_EN)
            page.screenshot(path=str(ASSETS / "p25-mobile-long-en.png"), full_page=False)
            measurements.append(record(page, "p25-mobile-long-en.png", viewport="390x844",
                                       scenario="long-name-en"))
            page.close()

            # 3. All six badges on one screen ----------------------------------
            # A six-row fixture, so the capture shows every badge it asserts on.
            # Six stacked rows (~690px) do not fit the 557px scroll area of a
            # 844px phone, and the page scrolls an inner container, so neither a
            # full-page capture nor a list-element capture shows them all.
            # The measurement is taken at 390x844; only then is the height grown
            # for the capture. Width stays 390, so the container query and every
            # row's layout are exactly what the measurement recorded.
            page, errors, calls = open_page(browser, width=390, height=844, profile_payload=SCENARIO_BADGES)
            scroll_to_section(page)
            data = record(page, "p25-mobile-badges.png", viewport="390x844", scenario="all-badges")
            page.set_viewport_size({"width": 390, "height": 1180})
            scroll_to_section(page)
            show_rows(page, "虚拟语气")
            page.screenshot(path=str(ASSETS / "p25-mobile-badges.png"), full_page=False)
            badges = [r["badgeText"] for r in data["rows"] if r["badgeText"]]
            for expected in ["学习中", "不稳定", "待复习", "存在误区", "稳定", "证据不足"]:
                ensure(expected in badges, f"badge {expected} missing, got {badges}")
            ensure(all(r["badgeVisible"] for r in data["rows"]), "a badge is not visible")
            measurements.append(data)
            page.close()

            # 3b. English copy -------------------------------------------------
            page, errors, calls = open_page(browser, width=390, height=844,
                                            profile_payload=SCENARIO_EN, lang="en")
            scroll_to_section(page)
            data = record(page, "p25-mobile-en-390.png", viewport="390x844", scenario="english")
            page.screenshot(path=str(ASSETS / "p25-mobile-en-390.png"), full_page=False)
            check_rows(data, viewport="390-en", require_stacked=True)
            body = page.locator("body").inner_text()
            ensure("Review date" in body, "English date label missing")
            ensure("复习日期" not in body, "Chinese leaked into the English layout")
            # The label and its value are separate elements; the CSS gap must not
            # be the only thing between them.
            date_text = next((r["dateText"] for r in data["rows"] if r["dateText"]), "")
            ensure("Review date" in date_text and "December" in date_text,
                   f"English date reads {date_text!r}")
            ensure(not errors, f"english errors: {errors}")
            measurements.append(data)
            page.close()

            # 4. Course-scoped view --------------------------------------------
            page, errors, calls = open_page(browser, width=390, height=844,
                                            profile_payload=SCENARIO, courses=COURSE_LIST)
            page.get_by_label("选择学习档案范围").focus()
            page.keyboard.press("Enter")
            page.get_by_role("option", name="同义替换").click()
            page.get_by_role("heading", name="知识掌握").wait_for(state="visible", timeout=15000)
            page.wait_for_timeout(400)
            course_card = page.locator("section", has=page.get_by_role("heading", name="知识掌握"))
            course_card.scroll_into_view_if_needed()
            page.wait_for_timeout(200)
            course = page.evaluate("""() => {
              const card = [...document.querySelectorAll('section')]
                .find((s) => s.querySelector('h2')?.textContent === '知识掌握');
              const rows = [...card.querySelectorAll('.mla-course-knowledge-row')];
              const doc = document.documentElement;
              return {
                rows: rows.map((r) => {
                  const strong = r.querySelector('strong');
                  const badge = r.querySelector('.mla-badge');
                  const ev = r.querySelector('.mla-course-knowledge-row__evidence');
                  const diag = r.querySelector('p');
                  return {
                    name: strong ? strong.textContent.trim() : null,
                    rowWidth: Math.round(r.getBoundingClientRect().width),
                    rowScrollWidth: r.scrollWidth, rowClientWidth: r.clientWidth,
                    nameWidth: strong ? Math.round(strong.getBoundingClientRect().width) : null,
                    nameScrollWidth: strong ? strong.scrollWidth : null,
                    nameClientWidth: strong ? strong.clientWidth : null,
                    badgeVisible: badge ? badge.getBoundingClientRect().width > 0 : false,
                    badgeText: badge ? badge.textContent.trim() : null,
                    evidenceVisible: ev ? ev.getBoundingClientRect().width > 0 : false,
                    evidenceText: ev ? ev.textContent.trim() : null,
                    diagnosisVisible: diag ? diag.getBoundingClientRect().width > 0 : false,
                    columns: getComputedStyle(r).gridTemplateColumns,
                  };
                }),
                documentOverflow: doc.scrollWidth > doc.clientWidth + 1,
              };
            }""")
            page.screenshot(path=str(ASSETS / "p25-course-mobile.png"), full_page=False)
            ensure(len(course["rows"]) == 4, f"course rows: {len(course['rows'])}")
            ensure(not course["documentOverflow"], "course view: document overflow")
            for row in course["rows"]:
                where = f"course / {(row['name'] or '')[:16]!r}"
                ensure(row["badgeVisible"], f"{where}: badge not visible")
                ensure(row["evidenceVisible"], f"{where}: evidence count not visible")
                ensure(row["diagnosisVisible"], f"{where}: diagnosis not visible")
                ensure(row["rowScrollWidth"] <= row["rowClientWidth"] + 1, f"{where}: row overflows")
                # The course row is stacked below 430px: one column.
                ensure(len(row["columns"].split()) == 1, f"{where}: expected a single column, got {row['columns']}")
            ensure(not errors, f"course view errors: {errors}")
            measurements.append({"file": "p25-course-mobile.png", "viewport": "390x844",
                                 "scenario": "course-mobile", **course})
            page.close()

            # 5. Editing on a phone --------------------------------------------
            page, errors, calls = open_page(browser, width=390, height=844, profile_payload=SCENARIO)
            open_editor(page, "虚拟语气", "手机端编辑草稿")
            scroll_to_section(page)
            data = record(page, "p25-mobile-editing.png", viewport="390x844", scenario="editing",
                          extra={"draftPreserved": "手机端编辑草稿" in " ".join(
                              page.evaluate("[...document.querySelectorAll('textarea')].map((t) => t.value)"))})
            page.screenshot(path=str(ASSETS / "p25-mobile-editing.png"), full_page=False)
            ensure(data["draftPreserved"], "editing: draft missing")
            ensure(not data["documentOverflow"], "editing: document overflow")
            measurements.append(data)
            page.close()

            # 6. Protected row on a phone --------------------------------------
            live = {"profile": SCENARIO}
            page, errors, calls = open_page(browser, width=390, height=844,
                                            profile_payload=SCENARIO, live=live)
            # Start from a filter the concept matches, then edit it.
            chip = knowledge_section(page).get_by_role("button", name=re.compile(r"^需要关注"))
            chip.first.click()
            page.wait_for_timeout(150)
            open_editor(page, "虚拟语气", "受保护草稿")
            # The server now reports it as stable, so it leaves the filter.
            live["profile"] = profile([
                state("c_short", "虚拟语气", "stable", mastery=0.5),
                *[s for s in SCENARIO["knowledge_states"] if s["concept_id"] != "c_short"],
            ])
            page.get_by_role("button", name=re.compile(r"^刷新|^Refresh")).click()
            page.wait_for_timeout(500)
            scroll_to_section(page)
            data = record(page, "p25-mobile-protected.png", viewport="390x844", scenario="protected",
                          extra={"draftPreserved": "受保护草稿" in " ".join(
                              page.evaluate("[...document.querySelectorAll('textarea')].map((t) => t.value)"))})
            page.screenshot(path=str(ASSETS / "p25-mobile-protected.png"), full_page=False)
            ensure(data["draftPreserved"], "protected: draft lost")
            notice = knowledge_section(page).locator('p[role="status"]')
            ensure(notice.count() >= 1, "protected: notice missing")
            ensure(not data["documentOverflow"], "protected: document overflow")
            measurements.append(data)
            page.close()

            METRICS.write_text(json.dumps({
                "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
                "base": BASE,
                "stackedMaxViewport": STACKED_MAX_VIEWPORT,
                "measurements": measurements,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(measurements)} measurements -> {METRICS}")
        finally:
            browser.close()


# ---------------------------------------------------------------------------
# E4.9i-P2-5-R1: R01–R06
# ---------------------------------------------------------------------------
#
# Separate entry point, separate outputs. `main()` above is the P2-5 suite and
# keeps writing `P2-5-assets/p25-*`; this writes only `p25-r1-*` and
# `r1-browser-metrics.json`, so running the R1 pass cannot overwrite the P2-5
# evidence the task book says to preserve.

R1_ASSETS = ASSETS
R1_METRICS = ASSETS / "r1-browser-metrics.json"


def switch_theme(page: Page, theme: str):
    """Change the theme the way the app does, through the real store.

    The suite writes `localStorage` before boot for the initial theme; a mid-run
    switch (R06) has to go through `themeStore.apply()`, which is the only writer
    of the DOM attribute, otherwise the capture would show a theme the app did
    not actually resolve.
    """
    page.evaluate(
        "(t) => import('/src/stores/theme-store.ts').then((m) => m.themeStore.apply(t))",
        theme,
    )
    page.wait_for_timeout(250)
    got = page.evaluate("document.documentElement.getAttribute('data-theme')")
    if got != theme:
        raise AssertionError(f"theme switch failed: wanted {theme}, DOM says {got}")


def open_row(page: Page, name: str):
    """Expand a knowledge row by its visible name."""
    row = knowledge_section(page).locator(".mla-knowledge-row", has_text=name).first
    header = row.locator(".mla-knowledge-row__header")
    if header.get_attribute("aria-expanded") == "false":
        header.click()
        page.wait_for_timeout(250)
    return row


def draft_values(page: Page) -> list[str]:
    return page.evaluate("[...document.querySelectorAll('textarea')].map((t) => t.value)")


def r1_main():
    R1_ASSETS.mkdir(parents=True, exist_ok=True)
    out: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            # --- R01: 320px, Chinese, dark ---------------------------------
            page, errors, calls = open_page(browser, width=320, height=640,
                                            profile_payload=SCENARIO, theme="dark")
            scroll_to_section(page)
            data = inspect(page)
            check_visible(data, where="R01 320-dark")
            ensure(data["theme"] == "dark", f"R01: theme is {data['theme']!r}, expected dark")
            show_rows(page, "虚拟语气")
            page.screenshot(path=str(R1_ASSETS / "p25-r1-320-dark.png"), full_page=False)

            # Also expand a long name in dark mode: F01's new line must be
            # readable on the dark surface too, not only on the light one.
            open_row(page, LONG_ZH)
            page.wait_for_timeout(250)
            expanded = inspect(page)
            check_visible(expanded, where="R01 320-dark expanded", require_full_name=True)
            zh = next(r for r in expanded["rows"] if r["name"] == LONG_ZH)
            ensure(zh["fullName"] and zh["fullName"]["height"] > 20,
                   "R01: full name did not wrap in dark mode")
            show_rows(page, LONG_ZH)
            page.screenshot(path=str(R1_ASSETS / "p25-r1-320-dark-expanded.png"), full_page=False)

            out.append({"scenario": "R01", "viewport": "320x640", "theme": "dark",
                        "lang": "zh-CN", "file": "p25-r1-320-dark.png",
                        "expandedShot": "p25-r1-320-dark-expanded.png",
                        "fullNameHeight": zh["fullName"]["height"],
                        "pageErrors": errors, **data})
            ensure(not errors, f"R01: page errors {errors}")
            page.close()

            # --- R02: 1440px, Chinese, dark --------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=SCENARIO, theme="dark")
            scroll_to_section(page)
            data = inspect(page)
            check_visible(data, where="R02 1440-dark")
            ensure(data["theme"] == "dark", f"R02: theme is {data['theme']!r}")
            page.screenshot(path=str(R1_ASSETS / "p25-r1-1440-dark.png"), full_page=False)
            out.append({"scenario": "R02", "viewport": "1440x900", "theme": "dark",
                        "lang": "zh-CN", "file": "p25-r1-1440-dark.png",
                        "pageErrors": errors, **data})
            ensure(not errors, f"R02: page errors {errors}")
            page.close()

            # --- R03: 320px, English, all six states -----------------------
            page, errors, calls = open_page(browser, width=320, height=640,
                                            profile_payload=SCENARIO_BADGES_EN, lang="en")
            scroll_to_section(page)
            data = inspect(page)
            check_visible(data, where="R03 320-en")
            badges = [r["badge"]["text"] for r in data["rows"] if r["badge"]]
            for expected in ["Learning", "Fragile", "Review due", "Misconception",
                             "Stable", "Insufficient evidence"]:
                ensure(expected in badges, f"R03: badge {expected!r} missing, got {badges}")
            show_rows(page, "Subjunctive mood")
            page.screenshot(path=str(R1_ASSETS / "p25-r1-320-en-badges.png"), full_page=False)
            out.append({"scenario": "R03", "viewport": "320x640", "theme": "light",
                        "lang": "en", "file": "p25-r1-320-en-badges.png",
                        "badges": badges, "pageErrors": errors, **data})
            ensure(not errors, f"R03: page errors {errors}")
            page.close()

            # --- R04: 320px, course-scoped read-only -----------------------
            page, errors, calls = open_page(browser, width=320, height=640,
                                            profile_payload=SCENARIO, courses=COURSE_LIST)
            page.get_by_label("选择学习档案范围").focus()
            page.keyboard.press("Enter")
            page.get_by_role("option", name="同义替换").click()
            page.get_by_role("heading", name="知识掌握").wait_for(state="visible", timeout=15000)
            page.wait_for_timeout(400)
            card = page.locator("section", has=page.get_by_role("heading", name="知识掌握"))
            card.scroll_into_view_if_needed()
            page.wait_for_timeout(200)
            course = page.evaluate("""() => {
              const round = (n) => Math.round(n * 10) / 10;
              const card = [...document.querySelectorAll('section')]
                .find((s) => s.querySelector('h2')?.textContent === '知识掌握');
              const list = card.querySelector('.mla-course-knowledge-list');
              const doc = document.documentElement;
              const rows = [...card.querySelectorAll('.mla-course-knowledge-row')];
              const clippers = (el) => {
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
              const visible = (el) => {
                if (!el) return null;
                const b = el.getBoundingClientRect();
                const box = {w: round(b.width), h: round(b.height),
                             left: round(b.left), right: round(b.right)};
                box.clippedBy = clippers(el).filter((c) => b.left < c.left - 1 || b.right > c.right + 1);
                box.textOverflowX = el.scrollWidth > el.clientWidth + 1;
                return box;
              };
              return {
                rows: rows.map((r) => {
                  const strong = r.querySelector('strong');
                  const badge = r.querySelector('.mla-badge');
                  const ev = r.querySelector('.mla-course-knowledge-row__evidence');
                  const diag = r.querySelector('p');
                  const rb = r.getBoundingClientRect();
                  const lb = list.getBoundingClientRect();
                  return {
                    name: strong ? strong.textContent.trim() : null,
                    row: {w: round(rb.width), left: round(rb.left), right: round(rb.right),
                          scrollWidth: r.scrollWidth, clientWidth: r.clientWidth,
                          overflowsContainer: r.scrollWidth > r.clientWidth + 1
                            || rb.right > lb.right + 1 || rb.left < lb.left - 1},
                    nameBox: visible(strong), badge: visible(badge),
                    evidence: visible(ev), diagnosis: visible(diag),
                    // The course view must stay read-only: no editor may exist.
                    hasEditor: !!r.querySelector('input, textarea'),
                    columns: getComputedStyle(r).gridTemplateColumns,
                  };
                }),
                documentOverflow: doc.scrollWidth > doc.clientWidth + 1,
                listOverflow: list.scrollWidth > list.clientWidth + 1,
              };
            }""")
            page.screenshot(path=str(R1_ASSETS / "p25-r1-320-course.png"), full_page=False)
            ensure(len(course["rows"]) == 4, f"R04: expected 4 rows, got {len(course['rows'])}")
            ensure(not course["documentOverflow"], "R04: document overflows horizontally")
            ensure(not course["listOverflow"], "R04: course list overflows horizontally")
            for row in course["rows"]:
                where = f"R04 / {(row['name'] or '')[:14]!r}"
                ensure(not row["row"]["overflowsContainer"], f"{where}: row wider than the list")
                ensure(not row["hasEditor"], f"{where}: course view is not read-only")
                for part in ("badge", "evidence", "diagnosis"):
                    node = row[part]
                    ensure(node and node["w"] > 0, f"{where}: {part} has no box")
                    ensure(not node["clippedBy"], f"{where}: {part} clipped {node['clippedBy']}")
                    ensure(not node["textOverflowX"], f"{where}: {part} text overflows its box")
                ensure(len(row["columns"].split()) == 1,
                       f"{where}: expected a single column at 320px, got {row['columns']}")
            out.append({"scenario": "R04", "viewport": "320x640", "theme": "light",
                        "lang": "zh-CN", "file": "p25-r1-320-course.png",
                        "pageErrors": errors, **course})
            ensure(not errors, f"R04: page errors {errors}")
            page.close()

            # --- R05: desktop long name readable after expanding -----------
            # The defect F01 fixed: the header ellipsises, so the reading view is
            # the only place the whole name can be read. This asserts the name is
            # actually painted in full, not merely present in the DOM.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=SCENARIO)
            scroll_to_section(page)
            before = inspect(page)
            zh_row = next(r for r in before["rows"] if r["name"] == LONG_ZH)
            ensure(zh_row["name_box"]["textOverflowX"],
                   "R05: the desktop header was expected to ellipsise this long name; "
                   "if it no longer does, the premise of F01 has changed")
            open_row(page, LONG_ZH)
            page.wait_for_timeout(250)
            data = inspect(page)
            check_visible(data, where="R05 1440-long-zh", require_full_name=True)
            zh = next(r for r in data["rows"] if r["name"] == LONG_ZH)
            full = zh["fullName"]
            ensure(full["width"] > 0 and full["height"] > 0, "R05: full name has no box")
            # At 1440 the reading view is wide enough for one line, and that is
            # fine: the requirement is that nothing is cut, not that it wraps at
            # every width. The wrap itself is asserted below at 320px.
            wide_height = full["height"]
            show_rows(page, LONG_ZH)
            page.screenshot(path=str(R1_ASSETS / "p25-r1-1440-long-name.png"), full_page=False)

            # Same expanded row on a phone: here it has to wrap, and the wrap must
            # not be achieved by clipping. This is the "允许正常换行" half of F01.
            page.set_viewport_size({"width": 320, "height": 640})
            page.wait_for_timeout(400)
            narrow = inspect(page)
            check_visible(narrow, where="R05 320-long-zh", require_full_name=True)
            zh_narrow = next(r for r in narrow["rows"] if r["name"] == LONG_ZH)
            full_narrow = zh_narrow["fullName"]
            ensure(full_narrow["height"] > 20,
                   f"R05: full name did not wrap at 320px (height {full_narrow['height']})")
            ensure(not full_narrow["textOverflowX"], "R05: wrapped name overflows its own box")
            ensure(not narrow["document"]["overflowsHorizontally"], "R05: page overflows at 320")
            page.screenshot(path=str(R1_ASSETS / "p25-r1-320-long-name-expanded.png"), full_page=False)

            out.append({"scenario": "R05", "theme": "light", "lang": "zh-CN",
                        "file": "p25-r1-1440-long-name.png",
                        "headerClippedBeforeExpand": zh_row["name_box"]["textOverflowX"],
                        "fullNameHeight1440": wide_height,
                        "fullNameHeight320": full_narrow["height"],
                        "narrowShot": "p25-r1-320-long-name-expanded.png",
                        "pageErrors": errors, **data})
            ensure(not errors, f"R05: page errors {errors}")
            page.close()

            # --- R06: edit at 1440 → 320 → back to 1440 ---------------------
            # The task book requires the draft, the editor identity and the
            # editing state to survive a width change in both directions.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=SCENARIO)
            open_editor(page, LONG_ZH, "跨视口草稿")
            at_1440 = {
                "drafts": draft_values(page),
                "expanded": knowledge_section(page).locator(
                    ".mla-knowledge-row", has_text=LONG_ZH).first
                    .locator(".mla-knowledge-row__header").get_attribute("aria-expanded"),
                "conceptName": knowledge_section(page).locator(
                    ".mla-knowledge-row", has_text=LONG_ZH).first
                    .locator(".mla-knowledge-row__name").text_content(),
                "editing": page.locator(".mla-knowledge-row textarea").count() > 0,
            }
            ensure("跨视口草稿" in " ".join(at_1440["drafts"]), "R06: draft missing at 1440")
            ensure(at_1440["editing"], "R06: not in the editor at 1440")

            page.set_viewport_size({"width": 320, "height": 640})
            page.wait_for_timeout(400)
            at_320 = {
                "drafts": draft_values(page),
                "expanded": knowledge_section(page).locator(
                    ".mla-knowledge-row", has_text=LONG_ZH).first
                    .locator(".mla-knowledge-row__header").get_attribute("aria-expanded"),
                "conceptName": knowledge_section(page).locator(
                    ".mla-knowledge-row", has_text=LONG_ZH).first
                    .locator(".mla-knowledge-row__name").text_content(),
                "editing": page.locator(".mla-knowledge-row textarea").count() > 0,
            }
            ensure("跨视口草稿" in " ".join(at_320["drafts"]), "R06: draft lost at 320")
            ensure(at_320["editing"], "R06: editor lost at 320")
            ensure(at_320["expanded"] == "true", "R06: row collapsed at 320")
            # A 320px viewport must not introduce horizontal overflow mid-edit.
            small = inspect(page)
            ensure(not small["document"]["overflowsHorizontally"], "R06: page overflows at 320")
            # Frame the capture on the editor itself; the section top would show
            # filters and no evidence that the draft survived.
            show_rows(page, LONG_ZH)
            page.screenshot(path=str(R1_ASSETS / "p25-r1-resize-320-editing.png"), full_page=False)

            page.set_viewport_size({"width": 1440, "height": 900})
            page.wait_for_timeout(400)
            at_back = {
                "drafts": draft_values(page),
                "expanded": knowledge_section(page).locator(
                    ".mla-knowledge-row", has_text=LONG_ZH).first
                    .locator(".mla-knowledge-row__header").get_attribute("aria-expanded"),
                "conceptName": knowledge_section(page).locator(
                    ".mla-knowledge-row", has_text=LONG_ZH).first
                    .locator(".mla-knowledge-row__name").text_content(),
                "editing": page.locator(".mla-knowledge-row textarea").count() > 0,
            }
            ensure("跨视口草稿" in " ".join(at_back["drafts"]), "R06: draft lost after returning to 1440")
            ensure(at_back["editing"], "R06: editor lost after returning to 1440")
            ensure(at_back["expanded"] == "true", "R06: row collapsed after returning to 1440")
            # Same editor, same concept: the draft belongs to this row throughout.
            ensure(at_back["conceptName"] == LONG_ZH, f"R06: row identity changed to {at_back['conceptName']!r}")
            ensure(at_back["drafts"] == at_1440["drafts"], "R06: draft content changed across the resize")
            show_rows(page, LONG_ZH)
            page.screenshot(path=str(R1_ASSETS / "p25-r1-resize-1440-editing.png"), full_page=False)
            out.append({"scenario": "R06", "theme": "light", "lang": "zh-CN",
                        "file": "p25-r1-resize-320-editing.png",
                        "at1440": at_1440, "at320": at_320, "backAt1440": at_back,
                        "pageErrors": errors})
            ensure(not errors, f"R06: page errors {errors}")
            page.close()

            R1_METRICS.write_text(json.dumps({
                "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
                "base": BASE,
                "note": "R01-R06 for E4.9i-P2-5-R1. The P2-5 originals are in p25-browser-metrics.json.",
                "scenarios": out,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK: {len(out)} R1 scenarios -> {R1_METRICS}")
        finally:
            browser.close()


if __name__ == "__main__":
    import sys
    if "--r1" in sys.argv:
        r1_main()
    else:
        main()
