"""v28 — the File Manager: a tree of EVERY repo, and a toolbar instead of a search box.

His words: "I SAID I NEED TREE STRUCTURE IN FILE MANAGER WHERE IT SHOWS ALL REPOS",
"IF I NEED TO DELETE MULTIPLE FILES AT ONCE FROM the repo, there's no such feature",
"put small icons or buttons whatever you call them, which show select all check box,
download, delete, search features".
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8733)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1680, "height": 1050}, accept_downloads=True)
    pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- every repo, as a tree --")
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: pg.locator(".repopick .ro-repo").count() > 0)
    shape = pg.evaluate("""()=>[...document.querySelectorAll('.ro-acct')].map(a=>({
        login:(a.querySelector('.ro-login')||{}).innerText||'',
        repos:[...a.querySelectorAll('.ro-repo')].map(rp=>({
          name:(rp.querySelector('.ro-name')||{}).innerText||'',
          apps:[...rp.querySelectorAll('.ro-appname')].map(x=>x.innerText.trim().split('\\n')[0])}))}))""")
    r.ok(len(shape) >= 2, "the repos are grouped under their GitHub account", str([a["login"] for a in shape]))
    r.ok([a["login"] for a in shape] == sorted(a["login"] for a in shape),
         "accounts in order", str([a["login"] for a in shape]))
    allrepos = [rp for a in shape for rp in a["repos"]]
    st = pg.evaluate("()=>{const m=new Set();for(const s of S.state.sites)if(s.linked)m.add(s.owner+'/'+s.repo);return m.size;}")
    r.ok(len(allrepos) == st, "EVERY repo that feeds an app is in the tree", f"{len(allrepos)} vs {st}")
    many = [rp for rp in allrepos if len(rp["apps"]) > 1]
    r.ok(many and all(rp["apps"] == sorted(rp["apps"]) for rp in many),
         "a repo with several apps lists them all, in order", str(many))
    r.ok(pg.locator(".ro-app .pk-url.copybtn").count() >= len(allrepos),
         "every app carries its address to copy")
    r.ok(pg.locator(".ro-app .tag").count() >= 1, "and the notes are on the apps they belong to")
    # ⚠ scope it: `.pickrow` is ALSO a button row on the Deploy screen
    r.ok(pg.locator("#fvPick .pickrow").count() == 0, "the old list of cards is gone")
    # nothing may run past the panel edge, at any width
    for w in (3440, 1680, 1280, 900, 390):
        pg.set_viewport_size({"width": w, "height": 950}); pg.wait_for_timeout(150)
        bad = pg.evaluate("""()=>{const out=[];document.querySelectorAll('.ro-acct').forEach(box=>{
          const B=box.getBoundingClientRect();
          box.querySelectorAll('*').forEach(el=>{const c=el.getBoundingClientRect();
            if(c.width&&c.right>B.right+1)out.push(el.className||el.tagName);});});return out.slice(0,4);}""")
        r.ok(not bad, f"the repo tree stays inside its card at {w}px", str(bad))
    pg.set_viewport_size({"width": 1680, "height": 1050})

    print("\n-- the toolbar --")
    pg.locator('.ro-open', has_text="brightleaf-web").first.click()
    wait_for(pg, lambda: pg.locator(".fvtree .fvt-app").count() > 0, timeout=15000)
    pg.wait_for_timeout(500)
    r.ok(pg.locator("#fvBar .iconbtn").count() == 4,
         "four small buttons: download, delete, clear, search", str(pg.locator("#fvBar .iconbtn").count()))
    r.ok(pg.locator("#fvBar #fvSelAll").count() == 1, "with the select-all tick beside them")
    r.ok(pg.locator("#fvBar .iconbtn svg").count() == 4, "each one an icon, no text")
    r.ok("hidden" in (pg.locator("#fvSearchWrap").get_attribute("class") or ""),
         "the wide search box is out of the way until it is asked for")
    r.ok(pg.locator("#fvBarDl").is_disabled() and pg.locator("#fvBarDel").is_disabled(),
         "download and delete are dead until something is ticked")

    pg.click("#fvBarFind"); pg.wait_for_timeout(250)
    r.ok("hidden" not in (pg.locator("#fvSearchWrap").get_attribute("class") or ""),
         "the search icon opens the box")
    r.ok(pg.locator("#fvSearch").evaluate("e=>e===document.activeElement"), "and puts the cursor in it")
    pg.click("#fvBarFind"); pg.wait_for_timeout(200)
    r.ok("hidden" in (pg.locator("#fvSearchWrap").get_attribute("class") or ""), "and closes it again")

    print("\n-- many files at once --")
    pg.click("label.rowck:has(#fvSelAll)"); pg.wait_for_timeout(400)
    cnt = pg.locator("#fvBarCount").inner_text()
    r.ok("selected" in cnt, "select-all says what it took", cnt)
    r.ok(not pg.locator("#fvBarDl").is_disabled() and not pg.locator("#fvBarDel").is_disabled(),
         "which wakes download and delete")
    before = pg.locator("#fvTree [data-ck]").count()
    pg.click("#fvBarDel"); pg.wait_for_timeout(400)
    # v29: one press opens a QUESTION. It used to arm the button itself, with the
    # question written on the control's own face — he asked for a real popup.
    r.ok(pg.locator("#fvTree [data-ck]").count() == before,
         "ONE press on delete removes nothing")
    r.ok(pg.locator("#fvDelDlg[open]").count() == 1,
         "it opens a confirm box instead of arming the button")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    with pg.expect_download(timeout=25000) as info:
        pg.click("#fvBarDl")
    dl = info.value
    r.ok(dl.suggested_filename.endswith(".zip"), "several files download as one zip", dl.suggested_filename)
    size = os.path.getsize(dl.path())
    r.ok(size > 100, "and the zip actually has bytes in it", str(size))
    import zipfile
    with zipfile.ZipFile(dl.path()) as z:
        names = z.namelist()
        bad = z.testzip()
    r.ok(bad is None, "it is a VALID zip a computer will open", str(bad))
    r.ok(len(names) >= 2, "carrying every file that was selected", str(names))

    pg.click("#fvBarClear"); pg.wait_for_timeout(300)
    r.ok(pg.locator("#fvBarCount").inner_text() == "", "Clear lets the selection go")
    r.ok(pg.locator("#fvBarDl").is_disabled(), "and the buttons go back to sleep")

    print("\n-- one file downloads as itself --")
    row = pg.locator('#fvTree [data-ck][data-cktype="f"]').first
    row.evaluate("e=>e.closest('label').click()")
    pg.wait_for_timeout(350)
    with pg.expect_download(timeout=25000) as info2:
        pg.click("#fvBarDl")
    one = info2.value
    r.ok(not one.suggested_filename.endswith(".zip"),
         "a single file is not wrapped in an archive", one.suggested_filename)
    r.ok(not errs, "no page errors in the whole run", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("filetools"))
