"""31 Aug — his screenshot: File Manager, every account collapsed, and NONE of
the controls did anything. "These buttons don't work if all are collapsed."

Cause: v34 turned the picker's force-collapse flag on by default, and a FORCED
value beats every click made afterwards. These assertions all start from the
state his screenshot was in — everything shut — because that is the state that
was broken and the one no earlier test entered.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8765)
r = Run()
repos = lambda pg: pg.locator("#fvPick .ro-repo").count()
accts = lambda pg: pg.locator("#fvPick .ro-acct").count()

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={"width": 1680, "height": 1050}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: accts(pg) > 0)
    pg.wait_for_timeout(400)

    r.ok(accts(pg) > 1 and repos(pg) == 0,
         "we start exactly where his screenshot was — accounts shut", f"{accts(pg)} accounts / {repos(pg)} repos")

    # ---- ONE account chevron, from all-collapsed -------------------------
    first = pg.locator("#fvPick .ro-acct [data-tw]").first
    key = first.get_attribute("data-tw")
    first.click()
    wait_for(pg, lambda: repos(pg) > 0, timeout=8000)
    r.ok(repos(pg) > 0, "clicking ONE account opens that account", f"{repos(pg)} repos")
    r.ok(pg.locator(f'#fvPick [data-tw="{key}"]').get_attribute("aria-expanded") == "true",
         "and its chevron says so")
    # and it closes again
    pg.locator(f'#fvPick [data-tw="{key}"]').click()
    wait_for(pg, lambda: repos(pg) == 0, timeout=8000)
    r.ok(repos(pg) == 0, "clicking it again closes it")

    # ---- the toolbar button, from all-collapsed --------------------------
    r.ok("Expand" in (pg.get_attribute("#fvPkCollapse", "title") or ""),
         "with everything shut the toolbar offers Expand",
         pg.get_attribute("#fvPkCollapse", "title"))
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) > 0, timeout=9000)
    n_all = repos(pg)
    r.ok(n_all >= 5, "and one press opens every account", str(n_all))
    r.ok("Collapse" in (pg.get_attribute("#fvPkCollapse", "title") or ""),
         "now it offers the opposite", pg.get_attribute("#fvPkCollapse", "title"))
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) == 0, timeout=9000)
    r.ok(repos(pg) == 0, "and press it again to shut them all")

    # ---- search, from all-collapsed --------------------------------------
    pg.click("#fvPkFind")
    wait_for(pg, lambda: pg.locator("#fvPkSearchWrap").is_visible())
    pg.click("#fvPkSearch"); pg.keyboard.type("cedar")
    wait_for(pg, lambda: repos(pg) > 0, timeout=8000)
    r.ok(repos(pg) > 0, "a search ANSWERS even though everything was shut", str(repos(pg)))
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(600)
    r.ok(repos(pg) == 0, "and clearing it puts the tree back as it was")

    # ---- refresh, from all-collapsed -------------------------------------
    pg.click("#fvPkRefresh")
    wait_for(pg, lambda: not pg.locator("#fvPkRefresh").is_disabled(), timeout=12000)
    r.ok(accts(pg) > 1, "refresh still reads the accounts back", str(accts(pg)))
    r.ok(not pg.locator("#fvPkRefresh").is_disabled(), "and frees its own button")

    # ---- a repo still opens its files ------------------------------------
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) > 0, timeout=9000)
    pg.locator("#fvPick .ro-open").first.click()
    wait_for(pg, lambda: pg.locator("#fvGrid, .fvt-row, .fv-row").count() > 0, timeout=12000)
    r.ok(pg.locator("#fvGrid, .fvt-row, .fv-row").count() > 0, "and a repo still opens its files")

    # ---- the SAME sweep on every other tree ------------------------------
    # The fault was one tree's forced state beating a click. Nothing proves the
    # other two are clean except entering them in the same state and clicking.
    for label, href, rowsel in (("Apps", "#/apps", ".apptbl-row"),
                                ("Repos", "#/repos", ".rt-app")):
        pg.click(f'.nav-item[href="{href}"]'); pg.wait_for_timeout(1300)
        pg.click('[data-act="tw-none"]'); pg.wait_for_timeout(800)
        tw = pg.locator(f'#setBody [data-tw]')
        if tw.count() == 0:
            r.ok(True, f"{label}: no tree on this screen to break")
            continue
        # ⚠ Repos HIDES its app rows with CSS instead of removing them, so a
        # count passes in both states. Count what is actually VISIBLE.
        vis = lambda: pg.eval_on_selector_all(rowsel, "e=>e.filter(x=>x.offsetParent!==null).length")
        r.ok(vis() == 0, f"{label}: starts shut", str(vis()))
        k = tw.first.get_attribute("data-tw")
        tw.first.click(); pg.wait_for_timeout(900)
        r.ok(vis() > 0, f"{label}: one chevron opens its own node from all-collapsed", str(vis()))
        r.ok(pg.eval_on_selector(f'#setBody [data-tw="{k}"]', "e=>e.getAttribute('aria-expanded')") == "true",
             f"{label}: and the chevron agrees")
        pg.locator(f'#setBody [data-tw="{k}"]').click(); pg.wait_for_timeout(900)
        r.ok(vis() == 0, f"{label}: and closes again", str(vis()))

    r.ok(not errs, "no console errors", str(errs))
    b.close()
srv.shutdown()
sys.exit(r.done("every tree, from all-collapsed"))
