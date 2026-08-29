"""29 Aug — his three: every tree opens COLLAPSED, Show all / Collapse all on
every page that has one, and a per-account Fetch apps on the Apps screen that is
reachable while the account is still closed.

His words: "on all pages, wherever there are collapsible cards, I want you to
make sure that default view is COLLAPSED Cards. And add a button which has
button to SHOW ALL, and COLLAPSE all" · "Must appear on collapsed card too".
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8762)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={"width": 1680, "height": 1050}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    def go(hash_):
        pg.click(f'.nav-item[href="{hash_}"]'); pg.wait_for_timeout(1400)

    # ---- Apps: collapsed by default -------------------------------------
    go("#/apps")
    wait_for(pg, lambda: pg.locator(".apptbl-group").count() > 0)
    groups = pg.locator(".apptbl-group").count()
    rows = pg.locator(".apptbl-row").count()
    r.ok(groups > 1, "the Apps screen has more than one account to fold", str(groups))
    r.ok(rows == 0, "and every account starts CLOSED — no app rows on first paint", str(rows))
    shut = pg.eval_on_selector_all('.apptbl-group [data-tw]',
                                   "e=>e.map(x=>x.getAttribute('aria-expanded'))")
    r.ok(all(v == "false" for v in shut), "the twisties say closed, so they do not lie", str(shut))

    # ---- Fetch apps is on the CLOSED heading -----------------------------
    fetch = pg.locator(".apptbl-group [data-act='fetch-combo']")
    r.ok(fetch.count() > 0, "a closed account heading still offers Fetch apps", str(fetch.count()))
    r.ok(fetch.first.is_visible(), "and it is actually visible while closed")
    ids = pg.eval_on_selector_all(".apptbl-group [data-act='fetch-combo']", "e=>e.map(x=>x.dataset.id)")
    r.ok(len(set(ids)) == len(ids) and all(ids), "each account fetches its own pairing", str(ids))
    fetch.first.click()
    # ⚠ an empty [role=status] node exists before the reply lands — waiting on the
    # NODE passes vacuously; wait on its TEXT.
    txt = lambda: pg.evaluate("()=>[...document.querySelectorAll('.toast,.toast-item,[role=status]')].map(e=>e.innerText).filter(Boolean).join(' | ')")
    wait_for(pg, lambda: bool(txt()), timeout=15000)
    msg = txt()
    r.ok("Heroku" in msg or "app" in msg.lower(), "pressing it reports back", msg)

    # ---- Show all / Collapse all ----------------------------------------
    for label, hash_, rowsel in (("Apps", "#/apps", ".apptbl-row"), ("Repos", "#/repos", ".rt-app, .attbl-row, .ltbl-row")):
        go(hash_)
        pg.wait_for_timeout(600)
        r.ok(pg.locator('[data-act="tw-all"]').count() == 1, f"{label}: one Show all button")
        r.ok(pg.locator('[data-act="tw-none"]').count() == 1, f"{label}: one Collapse all button")
    go("#/apps")
    pg.click('[data-act="tw-all"]'); pg.wait_for_timeout(700)
    opened = pg.locator(".apptbl-row").count()
    r.ok(opened > 0, "Show all opens every account", str(opened))
    r.ok(all(v == "true" for v in pg.eval_on_selector_all('.apptbl-group [data-tw]',
             "e=>e.map(x=>x.getAttribute('aria-expanded'))")), "and the twisties agree")
    pg.click('[data-act="tw-none"]'); pg.wait_for_timeout(700)
    r.ok(pg.locator(".apptbl-row").count() == 0, "Collapse all closes them again",
         str(pg.locator(".apptbl-row").count()))

    # ---- it survives a reload (localStorage, not per tab) ----------------
    pg.click('[data-act="tw-all"]'); pg.wait_for_timeout(700)
    n_open = pg.locator(".apptbl-row").count()
    pg.reload(); pg.wait_for_timeout(1200)
    go("#/apps"); pg.wait_for_timeout(700)
    r.ok(pg.locator(".apptbl-row").count() == n_open, "what you opened is still open after a reload",
         f"{pg.locator('.apptbl-row').count()} vs {n_open}")

    r.ok(not errs, "no console errors", str(errs))
    b.close()
srv.shutdown()
sys.exit(r.done("collapsed by default"))
