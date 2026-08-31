"""One repo, several apps: shown once, and a change reaches all of them.

Exists because veltrix and optier shared owner-c/optier, the File
Manager listed that repo once per app as if each had its own files, and a
change only ever rebuilt the app whose screen happened to be open.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8704)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1050}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- the repo is listed ONCE --")
    pg.click('.nav-item[href="#/files"]')
    pg.wait_for_timeout(600)
    # ⚠ 31 Aug: every tree opens COLLAPSED since v34. This suite is not about
    # folds — open the picker and carry on. (Fold behaviour: foldall / fmclicks.)
    try:
        pg.click("#fvPkCollapse")
    except Exception:
        pass
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0)
    names = pg.evaluate("()=>[...document.querySelectorAll('#fvPick .ro-name')].map(x=>x.innerText.trim())")
    r.ok(len(names) == len(set(names)), "no repo appears twice", str(names))
    # v28: repos are grouped UNDER their GitHub account, so A-to-Z holds within
    # each account, not across the whole flat list.
    groups = pg.evaluate("""()=>[...document.querySelectorAll('#fvPick .ro-acct')]
        .map(a=>[...a.querySelectorAll('.ro-name')].map(x=>x.innerText.trim().toLowerCase()))""")
    r.ok(all(g == sorted(g) for g in groups), "A to Z inside each account", str(groups))
    shared = pg.locator("#fvPick .ro-repo").filter(has=pg.locator(".ro-name", has_text="brightleaf-web")).first
    txt = shared.inner_text()
    r.ok("3 apps" in txt, "and it says how many apps it feeds", txt.replace("\n", " ")[:140])
    for app in ("brightleaf-web", "brightleaf-mirror", "brightleaf-eu"):
        r.ok(app in txt, f"naming {app}")
    r.ok(shared.locator(".pk-url").count() == 3, "with an address to copy for each",
         str(shared.locator(".pk-url").count()))

    print("\n-- opening it is opening the REPO --")
    shared.locator(".ro-open").click()
    r.ok(wait_for(pg, lambda: pg.inner_text("#fvTitle") == "northgate-ops/brightleaf-web"),
         "the heading is the repo, not one of its apps", pg.inner_text("#fvTitle"))
    sub = pg.inner_text("#fvSub")
    tree = pg.inner_text(".fvtree")
    r.ok("3 apps served" in tree, "the tree says how many apps it serves", tree[:160])
    names = pg.evaluate("()=>[...document.querySelectorAll('.fvt-app .fvt-name')].map(x=>x.innerText.trim())")
    r.ok(len(names) == 3, "and all three hang under it", str(names))
    r.ok("goes live on all 3 apps" in sub,
         "with the header saying plainly where a change here lands", sub[:160])

    print("\n-- a change goes to all of them --")
    pg.evaluate("""()=>{window.__built=[];const orig=window.api;window.api=async(p,o)=>{const r=await orig(p,o);
        if(/^\\/api\\/files\\//.test(p)&&o&&o.body&&!(o.body instanceof FormData))window.__built.push(r.apps||[]);return r;};}""")
    ok_write = pg.evaluate("""async ()=>{
        const id=S.fv.appId;
        const r=await api('/api/files/'+id,{body:{files:[{path:'index.html',contentB64:btoa('<p>hi</p>')}]}});
        return r.apps||[];}""")
    r.ok(sorted(ok_write) == sorted(["brightleaf-web", "brightleaf-mirror", "brightleaf-eu"]),
         "the save reports every app it rebuilt", str(ok_write))
    pg.click('.nav-item[href="#/log"]')
    wait_for(pg, lambda: "rebuilt after a file change" in pg.inner_text("#view-log"))
    log = pg.inner_text("#view-log")
    r.ok(log.count("rebuilt after a file change") >= 3, "and the log shows a rebuild for each")
    r.ok("fed by northgate-ops/brightleaf-web" in log, "saying which repo they were fed by")
    r.ok(not errs, "no page errors", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("onerepomanyapps"))
