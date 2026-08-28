"""The Repos screen is a tree: each repo, then the Heroku apps assigned to it —
and every Build button is one press per app, on whichever screen it is drawn."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8705)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1100}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- the tree --")
    pg.click('.nav-item[href="#/repos"]')
    wait_for(pg, lambda: pg.locator(".ltbl-repos .ltbl-row").count() > 0)
    tree = pg.evaluate("""()=>{const out=[];document.querySelectorAll('.ltbl-repos .ltbl-row').forEach(row=>{
        const name=row.querySelector('.nm')?row.querySelector('.nm').innerText.trim():'';
        const kids=row.nextElementSibling&&row.nextElementSibling.classList.contains('repotree')
          ?[...row.nextElementSibling.querySelectorAll('.rt-name')].map(x=>x.innerText.trim()):[];
        out.push({repo:name,apps:kids});});return out;}""")
    r.ok(len(tree) > 0, "the repos are listed", str(len(tree)))
    shared = [t for t in tree if "brightleaf-web" in t["repo"]]
    r.ok(shared and len(shared[0]["apps"]) == 3,
         "the repo with three apps shows all three beneath it", str(shared))
    r.ok(shared and shared[0]["apps"] == sorted(shared[0]["apps"]), "in order", str(shared[0]["apps"]))
    lone = [t for t in tree if "northgate-site" in t["repo"]]
    r.ok(lone and len(lone[0]["apps"]) == 1, "a repo with one app shows one", str(lone))
    unused = [t for t in tree if "landing-drafts" in t["repo"]]
    r.ok(unused and unused[0]["apps"] == [], "a repo nothing uses shows no branch at all", str(unused))
    r.ok(pg.locator(".repotree .rt-never").count() >= 1, "an app that was never built says so in the tree")
    r.ok(pg.locator(".repotree .rt-url.copybtn").count() >= 3, "each app carries its address to copy")

    print("\n-- one press per app --")
    btn = pg.locator('.repotree [data-act="build-now"]').first
    btn.click()
    r.ok(wait_for(pg, lambda: any("Building" in t for t in pg.locator(".toast").all_inner_texts())),
         "pressing Build starts a build")
    r.ok(wait_for(pg, lambda: btn.is_disabled()), "the button disables itself while it runs")
    r.ok("Building" in btn.inner_text(), "and says what it is doing", btn.inner_text())
    pg.click('.nav-item[href="#/apps"]')
    wait_for(pg, lambda: pg.locator(".apptbl-row").count() > 0)
    same = pg.evaluate("""()=>{const b=[...document.querySelectorAll('.apptbl-row [data-act=build-now]')]
        .filter(x=>x.disabled);return b.length;}""")
    r.ok(same >= 1, "the SAME app's button on another screen is disabled too — no double build", str(same))

    print("\n-- the Apps table lost what he called useless --")
    head = pg.inner_text(".apptbl-head")
    r.ok("BUILDS AS" not in head.upper(), "no 'Builds as' column", head.replace("\n", " "))
    r.ok(pg.locator('.apptbl-row [data-act="edit"]').count() == 0, "and no Edit button")
    r.ok(pg.locator('.apptbl-row [data-act="build-now"]').count() >= 1, "Build stays on every linked app")
    r.ok(not errs, "no page errors", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("repotree"))
