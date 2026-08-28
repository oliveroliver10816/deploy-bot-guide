"""His note on an app follows it everywhere it matters:
the Apps table, the Deploy card, and BOTH File Manager views."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8695)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1000}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- the Apps table --")
    pg.click('.nav-item[href="#/apps"]')
    wait_for(pg, lambda: pg.locator(".apptbl-row").count() > 0)
    row = pg.locator(".apptbl-row").filter(has=pg.locator(".at-name .nm", has_text="brightleaf-web")).first
    r.ok(row.locator(".tag.note-c-amber").count() == 1, "the note is in the row, in its colour")

    print("\n-- the Deploy card --")
    pg.click('.nav-item[href="#/deploy"]')
    card = pg.locator(".site-card").filter(has=pg.locator(".sc-domain .copytxt", has_text="brightleaf-web")).first
    r.ok(wait_for(pg, lambda: card.locator(".tag.note-c-amber").count() == 1),
         "and under the app name on Deploy, same colour")

    print("\n-- the File Manager picker --")
    pg.click('.nav-item[href="#/files"]')
    r.ok(wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0), "the picker shows the repo tree")
    # v23: the picker is a list of rows now, not cards
    pick = pg.locator("#fvPick .ro-repo").filter(
        has=pg.locator(".ro-name", has_text="brightleaf-web")).first
    r.ok(pick.locator(".tag").count() >= 1, "the app's tags show while you are choosing",
         str(pick.locator(".tag").count()))
    r.ok("Client site" in pick.inner_text(), "with the tag's own words",
         pick.inner_text().replace("\n", " ")[:110])
    r.ok(pick.locator(".tag.note-c-amber").count() >= 1, "in the colour it was given")
    # a repo whose apps carry NO tags at all — the demo keeps one on purpose
    plain = pg.evaluate("""()=>{const out=[];document.querySelectorAll('#fvPick .ro-repo').forEach(rp=>{
        if(!rp.querySelector('.tag'))out.push((rp.querySelector('.ro-name')||{}).innerText||'');});
        return out;}""")
    r.ok(len(plain) >= 1,
         "an app with no tags shows nothing extra — no empty line", str(plain))

    print("\n-- inside the repo --")
    pick.locator(".ro-open").click()
    r.ok(wait_for(pg, lambda: pg.inner_text("#fvTitle") == "northgate-ops/brightleaf-web"),
         "it opens the repo", pg.inner_text("#fvTitle"))
    # v27: the notes moved OUT of that one long grey sentence and INTO the tree,
    # beside the app each one belongs to. Same words, same colours, contained.
    tree = pg.inner_text(".fvtree")
    r.ok("northgate-ops/brightleaf-web" in tree, "the repo is the root of the tree", tree[:110])
    r.ok("Client site" in tree,
         "and the tag is shown with the app it belongs to", tree[:200])
    owner = pg.evaluate("""()=>{const n=[...document.querySelectorAll('.fvt-app')]
        .find(x=>/Client site/.test(x.innerText));
        return n?(n.querySelector('.fvt-name')||{}).innerText||'':'';}""")
    r.ok("brightleaf-web" in owner,
         "sitting under that app's own branch, since the repo feeds three", owner)
    r.ok(pg.locator(".fvtree .tag.note-c-amber").count() >= 1, "same colour here too")
    r.ok(not errs, "no page errors", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("notes"))
