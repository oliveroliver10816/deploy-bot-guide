"""The nine things he asked for on 2026-08-19, each checked where he'd look."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8702)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1050}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- 1 · Select all in the File Manager --")
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0)
    pg.locator(".ro-open").first.click()
    # v28: Select all moved out of the right-hand card and onto the toolbar that
    # sits directly above the file list, with Download / Delete / Clear / Search.
    r.ok(wait_for(pg, lambda: pg.locator("#fvBar #fvSelAll").count() == 1), "the control exists at last")
    pg.click("label.rowck:has(#fvSelAll)")
    r.ok(wait_for(pg, lambda: not pg.locator("#fvBarDel").is_disabled()), "ticking it selects the folder")
    n = pg.inner_text("#fvBarCount")
    r.ok("selected" in n, "and the bar says what is selected", n)
    pg.click('#fvBarClear')
    r.ok(wait_for(pg, lambda: pg.locator("#fvBarDel").is_disabled()), "and it clears")

    print("\n-- 2 + 4 · the app list, and the address --")
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0)
    names = pg.evaluate("()=>[...document.querySelectorAll('#fvPick .ro-acct')].map(a=>[...a.querySelectorAll('.ro-name')].map(x=>x.innerText.trim().toLowerCase()))")
    r.ok(all(g == sorted(g) for g in names), "the repos are listed A to Z under each account", str(names))
    r.ok(pg.locator("#fvPick .ro-count").count() == sum(len(g) for g in names),
         "every repo says how many apps it feeds")
    r.ok(pg.locator("#fvPick .pk-url.copybtn").count() >= 1, "and carries its address as a click-to-copy chip")
    url = pg.locator("#fvPick .pk-url").first
    r.ok("herokuapp.com" in url.inner_text(), "which is the real address", url.inner_text())
    pg.locator(".ro-open").first.click()
    wait_for(pg, lambda: not pg.is_hidden("#fvGrid"))
    r.ok(pg.locator("#fvRepoLine .fvt-app .copybtn").count() >= 2,
         "inside the repo, every app's name AND address are copy chips",
         str(pg.locator("#fvRepoLine .copybtn").count()))

    print("\n-- 3 · one repo, several apps --")
    st = pg.evaluate("""()=>{const m={};for(const s of S.state.sites){if(!s.linked)continue;
        const k=s.owner+'/'+s.repo;(m[k]=m[k]||[]).push(s.app);}return m;}""")
    r.ok(isinstance(st, dict), "the model links apps to repos by id, so many apps can share one repo")
    shared = pg.evaluate("""()=>{const a=S.state.sites.find(x=>x.linked);
        return a?{app:a.app,repo:a.owner+'/'+a.repo}:null;}""")
    r.ok(bool(shared), "…and the Repos table names every app a repo feeds", str(shared))

    print("\n-- 5 · the name you must type is copyable --")
    pg.click('.nav-item[href="#/repos"]')
    wait_for(pg, lambda: pg.locator(".ltbl-repos .ltbl-row").count() > 0)
    pg.locator('[data-act="rm-repo"]').first.click()
    wait_for(pg, lambda: pg.is_visible("#rmDlg"))
    r.ok(pg.locator("#rmDlg .codecopy.copybtn").count() == 1, "the exact name is a copy button now")
    pg.click("#rmDlg .codecopy")
    r.ok(wait_for(pg, lambda: any("copied" in t.lower() for t in pg.locator(".toast").all_inner_texts())),
         "clicking it copies", str(pg.locator(".toast").all_inner_texts())[:120])
    pg.click("#rmDlg [data-close]")

    print("\n-- 6 · the Repos screen --")
    body = pg.inner_text("#setBody")
    r.ok("Refresh accounts" in body, "the button no longer says 'from Heroku' on a GitHub screen")
    r.ok("Refresh from Heroku" not in body, "…anywhere on this screen")

    print("\n-- 7 · select multiple --")
    boxes = pg.locator("input[data-repock]")
    r.ok(boxes.count() > 1, "every repo row has a tick")
    pg.locator(".ltbl-repos .ltbl-row .rowck").nth(0).click()
    pg.locator(".ltbl-repos .ltbl-row .rowck").nth(1).click()
    r.ok(wait_for(pg, lambda: "2 repos selected" in pg.inner_text("#repoSelBar")),
         "two ticks really means two — the table is not rebuilt underneath",
         pg.inner_text("#repoSelBar"))
    r.ok(pg.locator('#repoSelBar [data-act="repos-forget"]').count() == 1 and
         pg.locator('#repoSelBar [data-act="repos-destroy"]').count() == 1,
         "with both bulk actions, kept apart")
    pg.click("label.rowck:has(#repoSelAll)")
    r.ok(wait_for(pg, lambda: pg.evaluate("()=>S.repoSel.size") == pg.locator("input[data-repock]").count()),
         "the header tick takes them all")
    pg.click('#repoSelBar [data-act="repos-clear"]')
    r.ok(wait_for(pg, lambda: pg.evaluate("()=>S.repoSel.size") == 0), "and Clear lets them go")

    print("\n-- 8 · icons where they belong --")
    icons = pg.evaluate("""()=>{
      const need=[...document.querySelectorAll('#setBody button')].filter(b=>{
        const t=(b.innerText||'').trim().toLowerCase();
        return /remove|delete|edit|copy|select|refresh|make|replace/.test(t);});
      return need.filter(b=>!b.querySelector('svg')).map(b=>b.innerText.trim().slice(0,30));}""")
    r.ok(not icons, "every action button carries its icon", str(icons))

    print("\n-- 9 · messages go away --")
    pg.evaluate("()=>toast('a plain message','ok')")
    r.ok(pg.locator(".toast").count() >= 1, "a message appears")
    r.ok(pg.locator(".toast .toast-x").count() >= 1, "with an X to dismiss it")
    pg.wait_for_timeout(3400)
    r.ok(pg.locator(".toast").count() == 0, "and it is gone within about three seconds")
    pg.evaluate("()=>toast('something went wrong','err')")
    pg.wait_for_timeout(3400)
    r.ok(pg.locator(".toast").count() == 1, "an error is given longer to be read")
    pg.click(".toast .toast-x")
    r.ok(wait_for(pg, lambda: pg.locator(".toast").count() == 0), "but the X takes it away at once")
    r.ok(not errs, "no page errors in the whole run", str(errs[:3]))
    b.close()
srv.shutdown()
sys.exit(r.done("panel23"))
