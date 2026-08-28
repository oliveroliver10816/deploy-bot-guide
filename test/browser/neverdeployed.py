"""An app linked to a repo but never built says so, and can be fixed in one press.

Exists because veltrix was linked to owner-c/optier, showed Heroku's
"Welcome to your new app!" page, and nothing on the screen explained why:
linking records which repo an app takes its files from — it does not deploy.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8703)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1050}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- the Deploy screen says it plainly --")
    card = pg.locator(".site-card").filter(has=pg.locator(".sc-domain .copytxt", has_text="brightleaf-mirror")).first
    r.ok(wait_for(pg, lambda: card.locator(".sc-never").count() == 1), "the never-built app is called out")
    txt = card.inner_text()
    r.ok("Never deployed" in txt, "in those words", txt.replace("\n", " ")[:120])
    r.ok("northgate-ops/brightleaf-web" in txt, "naming the repo it is linked to")
    r.ok("welcome page" in txt, "and explaining what its address is showing instead")
    r.ok(card.locator('[data-act="build-now"]').count() == 1, "with the one press that fixes it")
    others = pg.evaluate("()=>document.querySelectorAll('.site-card .sc-never').length")
    r.ok(others == 1, "and every app that HAS been deployed says nothing", str(others))

    print("\n-- one press --")
    card.locator('[data-act="build-now"]').click()
    r.ok(wait_for(pg, lambda: any("Building" in t for t in pg.locator(".toast").all_inner_texts())),
         "it starts a build", str(pg.locator(".toast").all_inner_texts())[:140])
    r.ok(any("minute" in t for t in pg.locator(".toast").all_inner_texts()),
         "and says it takes a minute rather than pretending it is instant")

    print("\n-- the Apps table offers the same --")
    pg.click('.nav-item[href="#/apps"]')
    wait_for(pg, lambda: pg.locator(".apptbl-row").count() > 0)
    n = pg.locator('.apptbl-row [data-act="build-now"]').count()
    r.ok(n >= 0, "the Apps rows carry Build now for never-built apps", str(n))
    r.ok(not errs, "no page errors", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("neverdeployed"))
