"""v27 — one press per repo, one press for everything, and the File Manager tree.

He was clicking Build on every app in turn. Two buttons replace that: one on each
repo row, and one at the top that covers the lot. This suite proves the presses
really fan out, that the button cannot be double-fired, that the buttons STAY
after a run, and that the File Manager shows the repo -> apps tree with notes.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8722)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1100}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept())          # the "build all N apps?" question
    signin(pg, BASE)

    # ---------------------------------------------------------------- per repo
    print("\n-- a Build button on each repo --")
    pg.click('.nav-item[href="#/repos"]')
    wait_for(pg, lambda: pg.locator(".ltbl-repos .ltbl-row").count() > 0)

    rows = pg.evaluate("""()=>[...document.querySelectorAll('.ltbl-repos .ltbl-row')].map(row=>({
        repo:(row.querySelector('.nm')||{}).innerText||'',
        build:!!row.querySelector('[data-act="build-repo"]'),
        label:(row.querySelector('[data-act="build-repo"]')||{}).innerText||'',
        apps:row.nextElementSibling&&row.nextElementSibling.classList.contains('repotree')
             ?row.nextElementSibling.querySelectorAll('.rt-app').length:0}))""")
    fed = [x for x in rows if x["apps"] > 0]
    r.ok(fed and all(x["build"] for x in fed),
         "every repo that feeds an app has its own Build button", str([x["repo"] for x in fed if not x["build"]]))
    r.ok(all(not x["build"] for x in rows if x["apps"] == 0),
         "and a repo nothing points at has none — there is nothing to build")
    many = [x for x in fed if x["apps"] > 1]
    r.ok(many and all(str(x["apps"]) in x["label"] for x in many),
         "a repo with several apps says how many the one press covers", str([x["label"] for x in many]))

    # count how many builds ONE repo press really starts
    target = pg.locator('.ltbl-repos .ltbl-row', has_text="brightleaf-web").first
    btn = target.locator('[data-act="build-repo"]')
    r.ok(btn.count() == 1, "the three-app repo has one button, not three")
    btn.click()
    # ⚠ read the BUSY state FIRST. The mock answers in ~200ms, so waiting for the
    # toast first lets the busy state come and go before the assertion — a check
    # made after the request passes or fails on timing, not on behaviour.
    busy_seen = wait_for(pg, lambda: btn.is_disabled(), timeout=4000, step=15)
    busy_text = btn.inner_text()
    r.ok(busy_seen, "the button goes busy while it runs")
    r.ok("Building" in busy_text, "and says so on the button itself", busy_text)
    r.ok(wait_for(pg, lambda: any("Building 3 app" in t for t in pg.locator(".toast").all_inner_texts())),
         "one press builds all three apps on it",
         str(pg.locator(".toast").all_inner_texts())[:200])
    # the per-app buttons under it must go busy too — they ARE building
    r.ok(wait_for(pg, lambda: target.locator("xpath=following-sibling::*[1]")
                  .locator('[data-act="build-now"][disabled]').count() >= 1),
         "the per-app buttons under it go busy too — the same apps are building")
    r.ok(wait_for(pg, lambda: not btn.is_disabled(), timeout=12000),
         "and the button comes back when the request lands — it is not thrown away")

    # ------------------------------------------------------------- everything
    print("\n-- one press for the lot --")
    allbtn = pg.locator('[data-act="build-all"]')
    r.ok(allbtn.count() == 1, "there is one Build-every-app button at the top")
    linked = pg.evaluate("()=>S.state.sites.filter(x=>x.linked).length")
    r.ok(str(linked) in allbtn.inner_text(),
         "it says how many apps it will touch", allbtn.inner_text() + f" (expected {linked})")
    allbtn.click()
    r.ok(wait_for(pg, lambda: pg.locator("#buildProg .rp-row").count() > 0),
         "pressing it shows one line per repo, filled in as each answers")
    r.ok(wait_for(pg, lambda: pg.locator("#buildProg .rp-row .ic").count() > 0, timeout=15000),
         "the lines resolve into results, not an endless spinner")
    r.ok(wait_for(pg, lambda: pg.locator("#buildProg .rp-row.bad").count() >= 1, timeout=20000),
         "a repo whose build is refused is marked as failed, not quietly skipped")
    ok_rows = pg.locator("#buildProg .rp-row:not(.bad)")
    r.ok(wait_for(pg, lambda: ok_rows.count() >= 2, timeout=20000),
         "and one bad repo does not cost the others", str(ok_rows.count()))
    r.ok(wait_for(pg, lambda: any("started" in t for t in pg.locator(".toast").all_inner_texts()),
                  timeout=20000), "a summary says how many builds started",
         str(pg.locator(".toast").all_inner_texts())[:250])
    r.ok(wait_for(pg, lambda: not allbtn.is_disabled(), timeout=20000),
         "the button is usable again afterwards — it stays, it is not consumed")

    # nothing may leak out of its box while all that is on screen
    over = pg.evaluate("""()=>{const bad=[];
      document.querySelectorAll('#view-settings .panel, #buildProg .notice').forEach(box=>{
        const B=box.getBoundingClientRect();
        box.querySelectorAll('*').forEach(el=>{const c=el.getBoundingClientRect();
          if(c.width&&c.right>B.right+1)bad.push((el.className||el.tagName)+' +'+Math.round(c.right-B.right));});});
      return bad.slice(0,6);}""")
    r.ok(not over, "nothing runs past the edge of its panel while it reports", str(over))

    # ------------------------------------------------------- File Manager tree
    print("\n-- the File Manager shows the tree it will change --")
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0)
    pg.locator('.ro-open', has_text="brightleaf-web").first.click()
    wait_for(pg, lambda: pg.locator(".fvtree .fvt-app").count() > 0, timeout=15000)
    t = pg.evaluate("""()=>({repo:(document.querySelector('.fvt-repo')||{}).innerText||'',
        sub:(document.querySelector('.fvt-sub')||{}).innerText||'',
        apps:[...document.querySelectorAll('.fvt-app .fvt-name')].map(x=>x.innerText.trim()),
        notes:document.querySelectorAll('.fvt-app .tag').length,
        urls:document.querySelectorAll('.fvt-app .fvt-url').length,
        marks:[...document.querySelectorAll('.fvt-line')].map(x=>x.innerText.trim())})""")
    r.ok("brightleaf-web" in t["repo"], "the repo is the root of the tree", t["repo"])
    r.ok(len(t["apps"]) == 3, "every app fed by it hangs underneath", str(t["apps"]))
    r.ok(t["apps"] == sorted(t["apps"]), "in order", str(t["apps"]))
    r.ok(t["marks"] and t["marks"][-1] == "└" and all(m == "├" for m in t["marks"][:-1]),
         "drawn as a tree, the last branch closed", str(t["marks"]))
    r.ok("3 apps served" in t["sub"], "and it says how many it serves", t["sub"])
    r.ok(t["notes"] >= 1, "the notes on those apps are shown with them", str(t["notes"]))
    r.ok(t["urls"] == 3, "each app carries its own address to copy", str(t["urls"]))
    line = pg.evaluate("()=>(document.querySelector('.fv-goeslive')||{}).innerText||''")
    r.ok("goes live on" in line and "brightleaf" in line,
         "and the folder card names what a change here will reach", line[:160])
    r.ok(pg.evaluate("()=>(document.querySelector('#fvSub')||{}).innerText||''").count("·") == 0,
         "the old grey sentence across the whole width is gone",
         pg.evaluate("()=>(document.querySelector('#fvSub')||{}).innerText||''")[:160])

    # the tree must stay inside its own column at every width
    for w in (3440, 1680, 1280, 900, 390):
        pg.set_viewport_size({"width": w, "height": 900})
        pg.wait_for_timeout(160)
        bad = pg.evaluate("""()=>{const t=document.querySelector('.fvtree');if(!t)return['no tree'];
          const B=t.getBoundingClientRect();const out=[];
          t.querySelectorAll('*').forEach(el=>{const c=el.getBoundingClientRect();
            if(c.width&&(c.right>B.right+1||c.left<B.left-1))out.push((el.className||el.tagName)+'');});
          return out.slice(0,4);}""")
        r.ok(not bad, f"the tree stays inside its box at {w}px", str(bad))

    r.ok(not errs, "no page errors anywhere in the run", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("buildall"))
