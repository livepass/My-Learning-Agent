"""E4.9i-P2-3 browser acceptance: real React profile page in Chromium.

Run from the repo root, after starting an isolated Vite server on 127.0.0.1:5193:

    (cd apps/learning-agent/web && npx vite --host 127.0.0.1 --port 5193 --strictPort)

then

    python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_3.py

Every /api request is answered by `page.route` from fixtures in this file, so no
real learner data is read or written and no backend is needed. The page is the
production bundle's dev-server build of the real components — not a prototype.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "http://127.0.0.1:5193/?page=profile"
# Only the backend API is intercepted; the dev server's own /src/api/*.ts modules
# must still be served, so a bare "**/api/**" glob is too broad.
API_ROUTE = re.compile(r"^http://127\.0\.0\.1:5193/api/")
PHASE = Path(__file__).resolve().parents[1]
ASSETS = PHASE / "P2-3-assets"
METRICS = ASSETS / "p23-browser-metrics.json"
# E4.9i-P2-3-R1 keeps its own metrics file so the P2-3 record stays intact.
R1_METRICS = ASSETS / "r1-browser-metrics.json"

VIEWPORTS = {
    "desktop": (1440, 900),
    "medium": (1024, 768),
    "tablet": (768, 1024),
    "mobile": (390, 844),
    "narrow": (320, 640),
}

TODAY = "2026-11-24T08:00:00.000Z"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def state(concept_id, name, label, *, domain="cet4", mastery=0.5, next_actions=None,
          diagnosis="诊断文本。", due=None):
    return {
        "concept_id": concept_id,
        "concept_name": name,
        "domain": domain,
        "state_label": label,
        "mastery": mastery,
        "confidence": 0.5,
        "stability": 0.5,
        "evidence_ids": ["e1"],
        "diagnosis": diagnosis,
        "next_actions": next_actions or [],
        "review_due_at": due,
    }


def profile(states, *, misconceptions=None, summary="以 CET4 阅读为主线：先补同义替换，再处理虚拟语气。",
            goals=None):
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


MISCONCEPTION = {
    "misconception_id": "m1", "concept_id": "c_misc", "description": "把近义词语体差异当成同义",
    "status": "active", "severity": 0.6, "confidence": 0.7,
    "first_seen_at": TODAY, "last_seen_at": TODAY, "evidence_ids": ["e1"],
    "repair_strategy": "用反例对比",
}

MIXED = profile(
    [
        state("c_stable", "同义替换", "stable", mastery=0.82,
              next_actions=["直接应用该概念，必要时安排更远迁移。"]),
        state("c_learn", "虚拟语气", "learning", mastery=0.35,
              next_actions=["先做一次无提示的低成本提取，不要提前重新讲解。"]),
        state("c_review", "连接词逻辑", "review_due", mastery=0.61,
              next_actions=["用一道轻微变式验证能否独立应用。"]),
        state("c_fragile", "段落主旨", "fragile", mastery=0.44, next_actions=[]),
        state("c_misc", "近义词辨析", "misconception", mastery=0.3,
              next_actions=["使用反例或表征转换定位并修复误区。"]),
        state("c_unknown", "推理题定位", "unknown", mastery=0.2, next_actions=[]),
    ],
    misconceptions=[MISCONCEPTION],
)

LONG_NAME = "超长知识点名称：用于验证在极窄屏幕下卡片内能够正确换行且内容不会被裁切或溢出"
LONG = profile([
    state("c_long1", LONG_NAME, "learning", next_actions=["先做一次无提示的低成本提取，不要提前重新讲解。"]),
    state("c_long2", "第二个很长很长很长很长很长很长的知识点名称用于检查换行行为", "fragile",
          next_actions=["用一道轻微变式验证能否独立应用，并记录证据。"]),
])

ONLY_UNKNOWN = profile([
    state("c_u1", "推理题定位", "unknown"),
    state("c_u2", "细节匹配", None),
    state("c_u3", "语义推断", "brand_new_label"),
])

NO_WEAK = profile([
    state("c_s1", "同义替换", "stable", next_actions=["保持迁移练习。"]),
    state("c_s2", "虚拟语气", "stable"),
])

EMPTY = profile([], summary="", goals=[])


# ---------------------------------------------------------------------------
# E4.9i-P2-3-R1 fixtures
# ---------------------------------------------------------------------------

def open_record(mid):
    return {**MISCONCEPTION, "misconception_id": mid}


# F01: misconception records with no knowledge states at all.
EMPTY_WITH_MISCONCEPTIONS = profile([], summary="", goals=[],
                                    misconceptions=[open_record("m1"), open_record("m2")])

# F01: only stable states, but two unresolved records.
STABLE_WITH_MISCONCEPTIONS = profile(
    [state("c_s1", "同义替换", "stable"), state("c_s2", "虚拟语气", "stable")],
    misconceptions=[open_record("m1"), open_record("m2")],
)

# F01: only unknown states, one unresolved record.
UNKNOWN_WITH_MISCONCEPTION = profile(
    [state("c_u1", "推理题定位", "unknown"), state("c_u2", "细节匹配", None)],
    misconceptions=[open_record("m1")],
)

# F02: malformed next_actions on weak concepts. Kept to three rows because the
# card previews three; a longer fixture would hide the case under test.
#   c_none   → []              → empty note
#   c_blank  → ["", " "]       → empty note (blank entries are not advice)
#   c_second → ["", "完成…"]   → the first *non-blank* entry
MISSING_ACTIONS = profile([
    {**state("c_none", "空数组项", "learning"), "next_actions": []},
    {**state("c_blank", "空白动作项", "fragile"), "next_actions": ["", " "]},
    {**state("c_second", "第二条有效", "learning"), "next_actions": ["", "完成一道变式练习"]},
])

# F02: a null next_actions must not be filled from the diagnosis.
DIAGNOSIS_ONLY = profile([
    {**state("c_diag", "仅诊断无建议", "learning", diagnosis="只能部分回忆"), "next_actions": None},
])

# F03: machine-generated names next to a legitimate one. Three rows because the
# card previews three.
SYNTHETIC_NAMES = profile([
    state("concept_45125622e640", "concept_45125622e640", "learning"),
    state("concept_45125622e640", "concept 45125622e640", "fragile"),
    state("c_cn", "同义替换", "learning"),
])

# F03: a legitimate English name must survive the same path.
LEGIT_EN_NAME = profile([state("c_en", "Synonyms", "learning")])


def empty_courses():
    return {"courses": []}


# ---------------------------------------------------------------------------
# Page plumbing
# ---------------------------------------------------------------------------

def install_routes(page: Page, *, profile_payload, fail_profile=False):
    """Answer every API call from fixtures; record requests for assertions."""
    calls: list[str] = []

    def handler(route, request):
        url = request.url
        calls.append(f"{request.method} {url.split('127.0.0.1:5193')[-1]}")
        path = url.split("127.0.0.1:5193")[-1].split("?")[0]
        if path == "/api/learner/profile" and request.method == "GET":
            if fail_profile:
                return route.fulfill(status=500, content_type="application/json",
                                     body=json.dumps({"error": "PROFILE_READ_FAILED"}))
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(profile_payload))
        if path == "/api/learner/profile" and request.method == "PATCH":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(profile_payload))
        if path == "/api/courses":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(empty_courses()))
        # Anything else the shell asks for: an empty, well-formed answer.
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

    page.route(API_ROUTE, handler)
    return calls


def set_prefs(page: Page, *, theme="light", lang="zh-CN"):
    page.add_init_script(
        f"localStorage.setItem('inno.theme', {json.dumps(theme)});"
        f"localStorage.setItem('inno.locale', {json.dumps(lang)});"
    )


def open_page(browser, *, width, height, profile_payload, theme="light", lang="zh-CN", fail_profile=False):
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    set_prefs(page, theme=theme, lang=lang)
    calls = install_routes(page, profile_payload=profile_payload, fail_profile=fail_profile)
    page.goto(BASE, wait_until="networkidle")
    page.locator(".mla-profile-container").wait_for(state="visible", timeout=15000)
    return page, errors, calls


def scroll_to_section(page: Page, needle: str):
    """Scroll the panel's own scroller so `needle`'s section header is at the top.

    `scroll_into_view_if_needed` stops as soon as any part is visible, which
    leaves the card half off-screen; these shots are meant to show it whole.
    """
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


def reset_scroll(page: Page):
    page.evaluate("""() => {
      const scroller = document.querySelector('.mla-profile-container')?.parentElement;
      if (scroller) scroller.scrollTop = 0;
      window.scrollTo(0, 0);
    }""")


def collect(page: Page) -> dict:
    """DOM facts used both for assertions and for the metrics file.

    The components carry no test-only attributes, so everything here is found
    structurally: a section is located by its heading text, and the conclusion
    is the block above the stat grid inside 概览.
    """
    return page.evaluate("""() => {
      const txt = (node) => (node ? node.textContent.trim() : null);
      const sectionByHeading = (needle) => [...document.querySelectorAll('section')]
        .find((s) => (s.querySelector('h4')?.textContent || '').includes(needle)) || null;

      const overview = sectionByHeading('概览') || sectionByHeading('Summary');
      const weakCard = sectionByHeading('需要关注的知识点') || sectionByHeading('needing attention');

      // Tiles: the four stat boxes carry a text-2xl value with a label above it.
      const tiles = overview ? [...overview.querySelectorAll('.text-2xl')].map((value) => ({
        label: txt(value.previousElementSibling),
        value: txt(value),
      })) : [];

      // Conclusion: every paragraph of the overview that precedes the stat grid.
      // The component renders a fact sentence plus optional follow-up lines, so
      // the whole block is joined rather than reduced to its first line.
      let conclusion = null;
      let conclusionParagraphs = [];
      let conclusionSource = null;
      let conclusionSuspended = null;
      let conclusionEmpty = null;
      if (overview) {
        const grid = overview.querySelector('.grid');
        conclusionParagraphs = [...overview.querySelectorAll('p')]
          .filter((p) => (grid ? Boolean(grid.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_PRECEDING) : true))
          .map(txt).filter(Boolean);
        if (conclusionParagraphs.length) {
          conclusion = conclusionParagraphs.join(' ');
          conclusionSource = conclusionParagraphs.find((p) => p.includes('不代表') || p.includes('do not represent')) || null;
          conclusionSuspended = conclusionParagraphs.find((p) => p.includes('已暂停') || p.includes('paused')) || null;
          conclusionEmpty = conclusionParagraphs.find((p) => p.includes('还没有已记录的知识点') || p.includes('No concepts recorded yet')) || null;
        }
      }

      const weakRows = weakCard ? [...weakCard.querySelectorAll('div.flex.flex-col > div')]
        .filter((row) => row.querySelector(':scope > div strong')).map((row) => {
          const head = row.querySelector(':scope > div');
          const action = [...row.querySelectorAll('p')].find((p) => p.textContent.trim());
          return {
            name: txt(head.querySelector('strong')),
            badge: txt(head.querySelector('.mla-badge')),
            action: txt(action),
            hasAction: Boolean(action && !action.textContent.includes('暂无') && !action.textContent.includes('No next action')),
          };
        }) : [];
      const weakParagraphs = weakCard ? [...weakCard.querySelectorAll('p')].map(txt).filter(Boolean) : [];
      const weakRemainder = weakParagraphs.find((p) => /另有|more concept/.test(p)) || null;
      const weakEmpty = weakCard && weakRows.length === 0 ? (weakParagraphs[0] || null) : null;

      const doc = document.documentElement;
      const body = document.body;
      const overflowIn = (root) => root ? [...root.querySelectorAll('*')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible')
        .slice(0, 6)
        .map((el) => ({ tag: el.tagName, cls: el.className.toString().slice(0, 60),
                        scrollW: el.scrollWidth, clientW: el.clientWidth,
                        left: Math.round(el.getBoundingClientRect().left),
                        right: Math.round(el.getBoundingClientRect().right) }))
        : [];
      // The two new blocks are what P2-3 owns. Any squeeze elsewhere is recorded
      // separately as pre-existing so it is neither blamed on nor hidden by this
      // phase.
      const newBlockOverflow = [...overflowIn(overview), ...overflowIn(weakCard)];
      const otherSections = [...document.querySelectorAll('.mla-profile-container section')]
        .filter((s) => s !== overview && s !== weakCard);
      const preExistingOverflow = otherSections.flatMap((s) => overflowIn(s)
        .map((o) => ({ ...o, section: txt(s.querySelector('h4')) })));
      const names = weakCard ? [...weakCard.querySelectorAll('strong')] : [];
      const nameRects = names.map((n) => {
        const r = n.getBoundingClientRect();
        return { text: n.textContent.slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) };
      });
      return {
        conclusion, conclusionParagraphs, conclusionSource, conclusionEmpty, conclusionSuspended,
        tiles,
        weakTitle: weakCard ? txt(weakCard.querySelector('h4')) : null,
        weakRows,
        weakCount: weakRows.length,
        weakRemainder,
        weakEmpty,
        weakParagraphs,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(txt),
        docOverflowX: doc.scrollWidth > doc.clientWidth,
        bodyOverflowX: body.scrollWidth > body.clientWidth,
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        newBlockOverflow,
        preExistingOverflow,
        nameRects,
        lang: document.documentElement.lang,
        theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className,
        sectionTitles: [...document.querySelectorAll('.mla-profile-container h4')].map(txt),
        editButtons: [...document.querySelectorAll('button')].filter((b) => txt(b) === '编辑摘要').length,
        // Exclude the section header's collapse toggle: only the card *body*
        // matters for "no practice / review control here".
        weakButtons: weakCard
          ? [...weakCard.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-expanded')).length
          : 0,
      };
    }""")


def shoot(page: Page, filename: str):
    """Screenshot the whole profile panel.

    The shell locks the document to the viewport height and the panel scrolls
    inside it, so `full_page=True` alone would capture only the first screen.
    The viewport is grown to the panel's content height for the shot and put
    back afterwards, which keeps the real layout (and its breakpoints) intact.
    """
    reset_scroll(page)
    viewport = page.viewport_size
    content = page.evaluate("""() => {
      const container = document.querySelector('.mla-profile-container');
      const scroller = container ? container.parentElement : null;
      return scroller ? scroller.scrollHeight : document.documentElement.scrollHeight;
    }""")
    chrome = page.evaluate("""() => {
      const container = document.querySelector('.mla-profile-container');
      const scroller = container ? container.parentElement : null;
      return scroller ? scroller.clientHeight : 0;
    }""")
    extra = max(0, content - chrome)
    page.set_viewport_size({"width": viewport["width"], "height": viewport["height"] + extra + 40})
    page.wait_for_timeout(150)
    reset_scroll(page)
    page.screenshot(path=str(ASSETS / filename), full_page=True)
    page.set_viewport_size(viewport)
    page.wait_for_timeout(80)


def ensure(condition, message):
    if not condition:
        raise AssertionError(message)


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
            # 1. Desktop mixed state -------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            data = record(page, "p23-desktop-overview.png", viewport="1440x900", scenario="mixed")
            shoot(page, "p23-desktop-overview.png")
            ensure(not data["docOverflowX"] and not data["bodyOverflowX"], "desktop overflow")
            ensure(data["tiles"] == [
                {"label": "活跃目标", "value": "1"},
                {"label": "已追踪概念", "value": "6"},
                {"label": "待复习状态", "value": "1"},
                {"label": "未解决的误解", "value": "1"},
            ], f"tile mismatch: {data['tiles']}")
            ensure("共记录 6 个知识点" in (data["conclusion"] or ""), "conclusion total missing")
            ensure("其中 4 个需要关注" in (data["conclusion"] or ""), "weak count missing")
            ensure("1 个状态稳定" in (data["conclusion"] or ""), "stable count missing")
            ensure("1 个证据不足" in (data["conclusion"] or ""), "unknown count missing")
            ensure("以今日学习中的服务端结果为准" in (data["conclusion"] or ""), "review caveat missing")
            ensure("不代表练习正确率或正式到期复习资格" in (data["conclusionSource"] or ""), "source caveat missing")
            ensure(data["sectionTitles"][:3] == ["概览", "知识状态", "需要关注的知识点"],
                   f"section order: {data['sectionTitles']}")
            ensure(not errors, f"desktop page errors: {errors}")

            # 2. Desktop weak card, scrolled into view --------------------------
            scroll_to_section(page, "需要关注的知识点")
            weak = record(page, "p23-desktop-weak.png", viewport="1440x900", scenario="weak")
            page.screenshot(path=str(ASSETS / "p23-desktop-weak.png"), full_page=False)
            ensure(weak["weakTitle"] == "需要关注的知识点", f"weak title: {weak['weakTitle']}")
            ensure(weak["weakCount"] == 3, f"weak preview count: {weak['weakCount']}")
            ensure(weak["weakRemainder"] and "另有 1 个" in weak["weakRemainder"],
                   f"remainder: {weak['weakRemainder']}")
            # The first row's stored next action is shown verbatim; the row with no
            # action says so instead of borrowing its diagnosis.
            ensure(weak["weakRows"][0]["hasAction"], "first weak row missing its action")
            ensure("先做一次无提示的低成本提取" in (weak["weakRows"][0]["action"] or ""), "action text mismatch")
            # 段落主旨 has no stored action: it stays listed and says so, rather
            # than being hidden or borrowing its diagnosis.
            ensure(weak["weakRows"][2]["name"] == "段落主旨", f"row order: {weak['weakRows']}")
            ensure(weak["weakRows"][2]["action"] == "暂无记录的下一步动作。",
                   f"missing-action fallback: {weak['weakRows'][2]['action']}")
            ensure(weak["weakButtons"] == 0, "weak card must not contain buttons")
            page.close()

            # 3. Empty ---------------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=EMPTY)
            data = record(page, "p23-desktop-empty.png", viewport="1440x900", scenario="empty")
            shoot(page, "p23-desktop-empty.png")
            ensure(data["conclusionEmpty"] and "还没有已记录的知识点" in data["conclusionEmpty"], "empty conclusion")
            ensure(data["weakEmpty"] and "形成正式学习记录后" in data["weakEmpty"], "empty weak copy")
            ensure(all(tile["value"] == "0" for tile in data["tiles"]), f"empty tiles: {data['tiles']}")
            ensure(len(data["tiles"]) == 4, "four original tiles must remain")
            ensure(not errors, f"empty page errors: {errors}")
            page.close()

            # 4. No weak -------------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=NO_WEAK)
            data = record(page, "p23-desktop-no-weak.png", viewport="1440x900", scenario="no-weak")
            page.get_by_role("button", name="需要关注的知识点").scroll_into_view_if_needed()
            page.screenshot(path=str(ASSETS / "p23-desktop-no-weak.png"), full_page=False)
            ensure(data["weakRows"] == [], "no-weak must not list rows")
            ensure("当前没有标记为需要关注的知识点" in (data["weakEmpty"] or ""), f"no-weak copy: {data['weakEmpty']}")
            ensure("2 个状态稳定" in (data["conclusion"] or ""), "stable count in conclusion")
            ensure("全部掌握" not in (data["conclusion"] or ""), "must not claim full mastery")
            page.close()

            # 5. Only unknown --------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=ONLY_UNKNOWN)
            data = record(page, "p23-desktop-unknown.png", viewport="1440x900", scenario="only-unknown")
            page.get_by_role("button", name="需要关注的知识点").scroll_into_view_if_needed()
            page.screenshot(path=str(ASSETS / "p23-desktop-unknown.png"), full_page=False)
            ensure("3 个证据不足" in (data["conclusion"] or ""), f"unknown conclusion: {data['conclusion']}")
            ensure("缺少可判断的状态" in (data["conclusion"] or ""), "unknown emphasis")
            # weakEmpty is only the first paragraph; the unknown note is a second one.
            ensure(any("其中 3 个知识点证据不足" in p for p in data["weakParagraphs"]),
                   f"weak unknown: {data['weakParagraphs']}")
            ensure("brand_new_label" not in json.dumps(data, ensure_ascii=False), "raw label leaked")
            page.close()

            # 6. Error: first read fails ---------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED,
                                            fail_profile=True)
            page.wait_for_timeout(300)
            data = record(page, "p23-desktop-error.png", viewport="1440x900", scenario="error")
            page.screenshot(path=str(ASSETS / "p23-desktop-error.png"), full_page=False)
            ensure(any("PROFILE_READ_FAILED" in a for a in data["alerts"]), f"error alert: {data['alerts']}")
            ensure(data["conclusion"] is None, "no conclusion may be drawn without data")
            ensure(data["weakTitle"] is None, "no weak card may be drawn without data")
            ensure(not errors, f"error page errors: {errors}")
            page.close()

            # 7. Refresh failure keeps stale data but suspends the conclusion ---
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            ensure("共记录 6 个知识点" in (collect(page)["conclusion"] or ""), "healthy conclusion missing")
            # Fail the next read only.
            page.unroute(API_ROUTE)
            install_routes(page, profile_payload=MIXED, fail_profile=True)
            page.get_by_role("button", name="刷新").click()
            page.wait_for_timeout(400)
            stale = record(page, "p23-desktop-refresh-failed.png", viewport="1440x900", scenario="refresh-failed")
            page.screenshot(path=str(ASSETS / "p23-desktop-refresh-failed.png"), full_page=False)
            ensure("已暂停根据旧数据" in (stale["conclusion"] or ""), f"suspended copy: {stale['conclusion']}")
            ensure("可能已过期" in " ".join(stale["alerts"]), f"stale notice: {stale['alerts']}")
            ensure("已暂停展示需要关注的知识点" in " ".join(stale["weakParagraphs"]),
                   f"weak suspended: {stale['weakParagraphs']}")
            ensure([t["value"] for t in stale["tiles"]] == ["1", "6", "1", "1"], "tiles must remain")
            page.close()

            # 7b. Refresh in flight suspends the conclusion ---------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED)
            ensure("共记录 6 个知识点" in (collect(page)["conclusion"] or ""), "healthy conclusion missing")
            page.unroute(API_ROUTE)

            def hanging_handler(route, request):
                path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
                if path == "/api/learner/profile":
                    return  # never fulfils: the read stays in flight
                return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

            page.route(API_ROUTE, hanging_handler)
            page.get_by_role("button", name="刷新").click()
            page.wait_for_timeout(400)
            refreshing = record(page, "p23-desktop-refreshing.png", viewport="1440x900", scenario="refreshing")
            page.screenshot(path=str(ASSETS / "p23-desktop-refreshing.png"), full_page=False)
            ensure("暂不生成学习结论" in (refreshing["conclusion"] or ""),
                   f"refreshing copy: {refreshing['conclusion']}")
            ensure("暂不展示需要关注的知识点" in " ".join(refreshing["weakParagraphs"]),
                   f"refreshing weak: {refreshing['weakParagraphs']}")
            ensure([t["value"] for t in refreshing["tiles"]] == ["1", "6", "1", "1"],
                   "tiles must remain during a refresh")
            page.close()

            # 8. Mobile 390 and 320 --------------------------------------------
            for key, filename in (("mobile", "p23-mobile-390.png"), ("narrow", "p23-mobile-320.png")):
                width, height = VIEWPORTS[key]
                page, errors, calls = open_page(browser, width=width, height=height, profile_payload=MIXED)
                data = record(page, filename, viewport=f"{width}x{height}", scenario="mixed")
                shoot(page, filename)
                ensure(not data["docOverflowX"], f"{filename}: document overflow")
                ensure(not data["newBlockOverflow"],
                       f"{filename}: new blocks overflow {data['newBlockOverflow']}")
                ensure(data["weakRows"] == data["weakRows"] and len(data["weakRows"]) == 3,
                       f"{filename}: weak rows")
                ensure(not errors, f"{filename}: page errors {errors}")
                page.close()

            # 8b. Medium and tablet widths -------------------------------------
            for key, filename, note in (
                ("medium", "p23-1024.png", "1024x768"),
                ("tablet", "p23-tablet-768.png", "768x1024"),
            ):
                width, height = VIEWPORTS[key]
                page, errors, calls = open_page(browser, width=width, height=height, profile_payload=MIXED)
                data = record(page, filename, viewport=note, scenario="mixed")
                shoot(page, filename)
                ensure(not data["docOverflowX"], f"{filename}: document overflow")
                ensure(not data["newBlockOverflow"], f"{filename}: new blocks overflow {data['newBlockOverflow']}")
                ensure("共记录 6 个知识点" in (data["conclusion"] or ""), f"{filename}: conclusion")
                ensure(not errors, f"{filename}: page errors {errors}")
                page.close()

            # 9. Mobile long names ---------------------------------------------
            page, errors, calls = open_page(browser, width=320, height=640, profile_payload=LONG)
            scroll_to_section(page, "需要关注的知识点")
            data = record(page, "p23-mobile-long-name.png", viewport="320x640", scenario="long-name")
            page.screenshot(path=str(ASSETS / "p23-mobile-long-name.png"), full_page=False)
            ensure(not data["docOverflowX"], "long-name document overflow")
            ensure(not data["newBlockOverflow"], f"long-name overflow: {data['newBlockOverflow']}")
            # A wrapped name is taller than one line (line-height 13.5px * ~1.5).
            ensure(all(rect["h"] > 24 for rect in data["nameRects"]), f"names did not wrap: {data['nameRects']}")
            ensure(all(rect["w"] <= 320 for rect in data["nameRects"]), "name wider than viewport")
            ensure(not errors, f"long-name page errors: {errors}")
            page.close()

            # 10. Dark theme ----------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, theme="dark")
            data = record(page, "p23-desktop-dark.png", viewport="1440x900", scenario="dark")
            shoot(page, "p23-desktop-dark.png")
            ensure("共记录 6 个知识点" in (data["conclusion"] or ""), "dark conclusion")
            ensure(not data["docOverflowX"], "dark overflow")
            page.close()

            # 11. English -------------------------------------------------------
            page, errors, calls = open_page(browser, width=1440, height=900, profile_payload=MIXED, lang="en")
            data = record(page, "p23-desktop-en.png", viewport="1440x900", scenario="english")
            scroll_to_section(page, "needing attention")
            page.screenshot(path=str(ASSETS / "p23-desktop-en.png"), full_page=False)
            ensure(data["lang"] == "en", f"lang: {data['lang']}")
            ensure("6 concepts recorded" in (data["conclusion"] or ""), f"en conclusion: {data['conclusion']}")
            ensure(data["weakTitle"] == "Concepts needing attention", f"en weak title: {data['weakTitle']}")
            ensure("do not represent practice accuracy" in (data["conclusionSource"] or ""), "en source caveat")
            ensure("共记录" not in (data["conclusion"] or ""), "Chinese leaked into English UI")
            page.close()

            # 12. Course view regression ---------------------------------------
            page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            set_prefs(page)
            course_calls: list[str] = []

            def course_handler(route, request):
                path = request.url.split("127.0.0.1:5193")[-1].split("?")[0]
                course_calls.append(f"{request.method} {path}")
                if path == "/api/learner/profile":
                    # The all-courses panel still mounts (and loads) behind the
                    # course view; give it a valid, distinct fixture so the test
                    # can prove its conclusion never appears in the course view.
                    return route.fulfill(status=200, content_type="application/json",
                                         body=json.dumps(MIXED))
                if path == "/api/courses":
                    body = {"courses": [{
                        "course_id": "course_python", "title": "Python 编程", "description": "",
                        "status": "in_progress", "created_at": TODAY, "updated_at": TODAY,
                        "counts": {"goals": 0, "plans": 1, "tasks": 2, "sessions": 0, "sources": 0},
                    }]}
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
                if path == "/api/courses/course_python/learner":
                    body = {
                        "course": {"course_id": "course_python", "title": "Python 编程", "description": "",
                                   "status": "in_progress", "created_at": TODAY, "updated_at": TODAY},
                        "goals": [],
                        "knowledge_states": [
                            {**state("k1", "列表推导", "learning", next_actions=["做一道变式。"]), "evidence_ids": ["a", "b"]},
                            {**state("k2", "装饰器", "stable"), "evidence_ids": ["c"]},
                        ],
                        "preferences": {"explanation_style": [], "practice_style": [],
                                        "feedback_tone": [], "avoid": []},
                        "unclassified": {"knowledge_states": 0, "goals": 0},
                    }
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
                if path == "/api/courses/daily":
                    # The course view reads courses[0].task_progress; an empty
                    # object here would make that read throw.
                    body = {"date": "2026-11-24", "daily_minutes": 30, "courses": [], "notes": []}
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
                return route.fulfill(status=200, content_type="application/json", body=json.dumps({}))

            page.route(API_ROUTE, course_handler)
            page.goto(BASE, wait_until="networkidle")
            # The course view renders inside .mla-profile-body, not the all-courses
            # panel's .mla-profile-container.
            page.locator(".mla-profile").wait_for(state="visible", timeout=15000)
            # Choose the course in the scope Select (Radix: open with the keyboard).
            trigger = page.get_by_label("选择学习档案范围")
            trigger.focus()
            page.keyboard.press("Enter")
            page.get_by_role("option", name="Python 编程").click()
            page.get_by_role("heading", name="知识掌握").wait_for(state="visible", timeout=15000)
            course_data = page.evaluate("""() => {
              const txt = (n) => (n ? n.textContent.trim() : null);
              const facts = [...document.querySelectorAll('.mla-fact')].map((f) => ({
                value: txt(f.querySelector('strong')), label: txt(f.querySelector('span')),
              }));
              const overview = [...document.querySelectorAll('section')]
                .find((s) => (s.querySelector('h4')?.textContent || '').includes('概览'));
              return {
                facts,
                allCoursesConclusion: overview ? txt(overview.querySelector('p')) : null,
                weakTitle: [...document.querySelectorAll('h2')].map(txt).filter((t) => t && t.includes('需要关注')),
                editButtons: [...document.querySelectorAll('button')].filter((b) => txt(b) === '编辑').length,
                sliders: document.querySelectorAll('input[type="range"]').length,
              };
            }""")
            page.screenshot(path=str(ASSETS / "p23-course-regression.png"), full_page=False)
            ensure(course_data["allCoursesConclusion"] is None, "all-courses conclusion leaked into course view")
            ensure(course_data["editButtons"] == 0 and course_data["sliders"] == 0, "course view must stay read-only")
            ensure(course_data["weakTitle"] == ["需要关注的知识点"], f"course weak section: {course_data['weakTitle']}")
            ensure({"value": "2", "label": "知识状态"} in course_data["facts"]
                   or any(f["value"] == "2" for f in course_data["facts"]), f"course facts: {course_data['facts']}")
            measurements.append({"file": "p23-course-regression.png", "viewport": "1440x900",
                                 "scenario": "course", **course_data})
            page.close()

            # ------------------------------------------------------------------
            # E4.9i-P2-3-R1 专项复验
            # ------------------------------------------------------------------
            r1 = []

            def record_r1(page, filename, *, viewport, scenario):
                data = collect(page)
                data.update({"file": filename, "viewport": viewport, "scenario": scenario})
                r1.append(data)
                return data

            # R1-1. No knowledge states, but two unresolved misconception records.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=EMPTY_WITH_MISCONCEPTIONS)
            d = record_r1(page, "r1-desktop-empty-misconceptions.png", viewport="1440x900", scenario="empty-misconceptions")
            shoot(page, "r1-desktop-empty-misconceptions.png")
            ensure("还没有已记录的知识点" in (d["conclusion"] or ""), f"R1 empty lead: {d['conclusion']}")
            ensure("另有 2 条未解决的误区记录" in (d["conclusion"] or ""),
                   f"R1 record line missing with no concepts: {d['conclusionParagraphs']}")
            ensure(not errors, f"R1 empty-misconceptions errors: {errors}")
            page.close()

            # R1-2. All stable, but two unresolved records.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=STABLE_WITH_MISCONCEPTIONS)
            d = record_r1(page, "r1-desktop-stable-misconceptions.png", viewport="1440x900", scenario="stable-misconceptions")
            page.screenshot(path=str(ASSETS / "r1-desktop-stable-misconceptions.png"), full_page=False)
            ensure("2 个状态稳定" in (d["conclusion"] or ""), f"R1 stable conclusion: {d['conclusion']}")
            ensure("当前没有标记为需要关注的知识点" in (d["conclusion"] or ""), "R1 no-weak line missing")
            ensure("另有 2 条未解决的误区记录" in (d["conclusion"] or ""),
                   f"R1 record line missing beside stable: {d['conclusionParagraphs']}")
            ensure(not errors, f"R1 stable-misconceptions errors: {errors}")
            page.close()

            # R1-3. Only unknown states, one unresolved record.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=UNKNOWN_WITH_MISCONCEPTION)
            d = record_r1(page, "r1-desktop-unknown-misconceptions.png", viewport="1440x900", scenario="unknown-misconceptions")
            page.screenshot(path=str(ASSETS / "r1-desktop-unknown-misconceptions.png"), full_page=False)
            ensure("缺少可判断的状态" in (d["conclusion"] or ""), f"R1 unknown emphasis: {d['conclusion']}")
            ensure("另有 1 条未解决的误区记录" in (d["conclusion"] or ""),
                   f"R1 record line missing beside unknown: {d['conclusionParagraphs']}")
            ensure(not errors, f"R1 unknown-misconceptions errors: {errors}")
            page.close()

            # R1-4. Malformed next_actions must not crash; the empty note shows.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=MISSING_ACTIONS)
            d = record_r1(page, "r1-desktop-missing-actions.png", viewport="1440x900", scenario="missing-actions")
            scroll_to_section(page, "需要关注的知识点")
            page.screenshot(path=str(ASSETS / "r1-desktop-missing-actions.png"), full_page=False)
            actions = [row["action"] for row in d["weakRows"]]
            ensure(len(actions) == 3, f"R1 missing-actions: expected three rows, got {actions}")
            ensure(all(a for a in actions), f"R1 missing-actions: a row has no action text: {actions}")
            ensure(sum(1 for a in actions if "暂无记录的下一步动作" in (a or "")) == 2,
                   f"R1 missing-actions: expected two empty notes, got {actions}")
            ensure(sum(1 for a in actions if "完成一道变式练习" in (a or "")) == 1,
                   f"R1 missing-actions: the valid second entry must show once: {actions}")
            ensure(not errors, f"R1 missing-actions errors: {errors}")
            page.close()

            # R1-4b. A null action is never filled from the diagnosis.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=DIAGNOSIS_ONLY)
            d = record_r1(page, "r1-desktop-diagnosis-only.png", viewport="1440x900", scenario="diagnosis-only")
            scroll_to_section(page, "需要关注的知识点")
            page.screenshot(path=str(ASSETS / "r1-desktop-diagnosis-only.png"), full_page=False)
            actions = [row["action"] for row in d["weakRows"]]
            ensure(actions == ["暂无记录的下一步动作。"], f"R1 diagnosis-only: {actions}")
            ensure("只能部分回忆" not in json.dumps(d, ensure_ascii=False),
                   "R1 diagnosis-only: diagnosis leaked into an action slot")
            ensure(not errors, f"R1 diagnosis-only errors: {errors}")
            page.close()

            # R1-5. Machine-generated names degrade to the placeholder.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=SYNTHETIC_NAMES)
            d = record_r1(page, "r1-desktop-synthetic-name.png", viewport="1440x900", scenario="synthetic-name")
            scroll_to_section(page, "需要关注的知识点")
            page.screenshot(path=str(ASSETS / "r1-desktop-synthetic-name.png"), full_page=False)
            names = [row["name"] for row in d["weakRows"]]
            ensure(names.count("知识点名称待确认") == 2, f"R1 synthetic names not degraded: {names}")
            ensure("concept_45125622e640" not in names and "concept 45125622e640" not in names,
                   f"R1 synthetic name leaked: {names}")
            ensure("同义替换" in names, f"R1 legitimate name lost: {names}")
            ensure(not errors, f"R1 synthetic-name errors: {errors}")
            page.close()

            # R1-5b. A legitimate English name is kept.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=LEGIT_EN_NAME, lang="en")
            d = record_r1(page, "r1-desktop-legit-name.png", viewport="1440x900", scenario="legit-english-name")
            scroll_to_section(page, "needing attention")
            page.screenshot(path=str(ASSETS / "r1-desktop-legit-name.png"), full_page=False)
            ensure([row["name"] for row in d["weakRows"]] == ["Synonyms"],
                   f"R1 legit English name lost: {[row['name'] for row in d['weakRows']]}")
            ensure(not errors, f"R1 legit-name errors: {errors}")
            page.close()

            # R1-6. Extreme narrow width still holds up.
            page, errors, calls = open_page(browser, width=320, height=640,
                                            profile_payload=EMPTY_WITH_MISCONCEPTIONS)
            d = record_r1(page, "r1-mobile-320.png", viewport="320x640", scenario="narrow-empty-misconceptions")
            shoot(page, "r1-mobile-320.png")
            ensure(not d["docOverflowX"], "R1 320: document overflow")
            ensure(not d["newBlockOverflow"], f"R1 320: new blocks overflow {d['newBlockOverflow']}")
            ensure("另有 2 条未解决的误区记录" in (d["conclusion"] or ""), "R1 320: record line missing")
            ensure(not errors, f"R1 320 errors: {errors}")
            page.close()

            # R1-7. English copy for the conclusion and the abnormal data.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=EMPTY_WITH_MISCONCEPTIONS, lang="en")
            d = record_r1(page, "r1-desktop-en.png", viewport="1440x900", scenario="english")
            shoot(page, "r1-desktop-en.png")
            ensure(d["lang"] == "en", f"R1 en lang: {d['lang']}")
            ensure("No concepts recorded yet." in (d["conclusion"] or ""), f"R1 en lead: {d['conclusion']}")
            ensure("There are also 2 unresolved misconception records" in (d["conclusion"] or ""),
                   f"R1 en record line: {d['conclusionParagraphs']}")
            ensure("未解决" not in (d["conclusion"] or ""), "R1 en: Chinese leaked")
            ensure(not errors, f"R1 en errors: {errors}")
            page.close()

            # R1 English abnormal data: the empty-action note in English.
            page, errors, calls = open_page(browser, width=1440, height=900,
                                            profile_payload=MISSING_ACTIONS, lang="en")
            d = record_r1(page, "r1-desktop-en-actions.png", viewport="1440x900", scenario="english-missing-actions")
            scroll_to_section(page, "needing attention")
            page.screenshot(path=str(ASSETS / "r1-desktop-en-actions.png"), full_page=False)
            en_actions = [row["action"] for row in d["weakRows"]]
            ensure(en_actions.count("No next action recorded yet.") == 2,
                   f"R1 en empty actions: {en_actions}")
            ensure("Next action: 完成一道变式练习" in en_actions, f"R1 en valid action: {en_actions}")
            ensure(not errors, f"R1 en-actions errors: {errors}")
            page.close()
        finally:
            browser.close()

    METRICS.write_text(json.dumps({
        "runtime": "Playwright Chromium, controlled fixtures via page.route, no backend, no writes",
        "base": BASE,
        "measurements": measurements,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    R1_METRICS.write_text(json.dumps({
        "runtime": "E4.9i-P2-3-R1 re-verification; controlled fixtures via page.route, no backend, no writes",
        "base": BASE,
        "measurements": r1,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {len(measurements)} P2-3 scenarios -> {METRICS}")
    print(f"OK: {len(r1)} R1 scenarios -> {R1_METRICS}")


if __name__ == "__main__":
    main()
