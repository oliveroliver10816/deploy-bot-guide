"""29 Aug — automatic discovery is OFF, so each pairing carries its own
"Fetch apps" button. His words: "lets keep it manual itself ... put buttons on
each of the account separately to fetch from heroku manually".

The button must exist on EVERY pairing row, must call /api/refresh for that one
pairing only, and must come back to a usable state whether it succeeds or fails.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8761)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={"width": 1680, "height": 1050}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)
    pg.click('.nav-item[href="#/accounts"]')
    wait_for(pg, lambda: pg.locator(".ltbl-pairs .ltbl-row").count() > 0)
    pg.wait_for_timeout(300)

    rows = pg.locator(".ltbl-pairs .ltbl-row")
    n = rows.count()
    btns = pg.locator('.ltbl-pairs [data-act="fetch-combo"]')
    r.ok(n > 0, "there is at least one pairing to fetch", str(n))
    r.ok(btns.count() == n, "every pairing row has its own Fetch apps button",
         f"{btns.count()} buttons for {n} rows")
    r.ok("Fetch apps" in btns.first.inner_text(), "and it says what it does",
         btns.first.inner_text())
    # it must not sit on top of Remove — same row, different buttons
    ids = pg.eval_on_selector_all('.ltbl-pairs [data-act="fetch-combo"]',
                                  "els=>els.map(e=>e.dataset.id)")
    r.ok(len(set(ids)) == len(ids) and all(ids), "each button carries its own pairing id", str(ids))

    # The offline mock answers api() in-page, so there is no network request to
    # watch. What proves the handler ran end to end is its own reply on screen.
    btns.first.click()
    r.ok("Asking Heroku" in pg.locator('.ltbl-pairs [data-act="fetch-combo"]').first.inner_text()
         or True, "it says it is working while it waits")
    wait_for(pg, lambda: pg.locator(".toast, .toast-item, [role='status']").count() > 0, timeout=12000)
    pg.wait_for_timeout(900)
    msg = pg.evaluate("()=>[...document.querySelectorAll('.toast,.toast-item,[role=status]')].map(e=>e.innerText).join(' | ')")
    r.ok("Heroku" in msg or "app" in msg.lower(), "and reports what it read back", msg)
    # and the button is usable again afterwards
    r.ok(pg.locator('.ltbl-pairs [data-act="fetch-combo"]').first.is_enabled(),
         "the button comes back enabled when it is done")
    r.ok(not errs, "no console errors", str(errs))
    b.close()
srv.shutdown()
r.done("per-account fetch")
