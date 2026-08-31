"""v31 — his three: tags instead of notes, one press to take one off, and the
Apps screen grouped into a tree.

His words: "make them as tags, so that we can select from pre-written tags and
just click to settle on any app" · "Make removing a note/tag easier, by just
clicking it and it gets deleted (X button on side)" · "Separate Apps in Tree
structure like we did in File manager and Repos".
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8755)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={"width": 1680, "height": 1050}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    signin(pg, BASE)
    pg.click('.nav-item[href="#/apps"]')
    wait_for(pg, lambda: pg.locator(".apptbl-group").count() > 0)
    # ⚠ 31 Aug: since v34 every tree opens COLLAPSED, so there are no app rows
    # until something is opened. This suite is about tags, not folds — open it
    # and carry on. (Its own fold assertions live in foldall.py / fmclicks.py.)
    pg.click('[data-act="tw-all"]')
    wait_for(pg, lambda: pg.locator(".apptbl-row").count() > 0)
    pg.wait_for_timeout(400)

    # ------------------------------------------------------ (3) the tree ----
    print("\n-- Apps as a tree --")
    groups = pg.evaluate("""()=>[...document.querySelectorAll('.apptbl-group')]
        .map(g=>({name:(g.querySelector('.ag-name')||{}).innerText||'',
                  n:(g.querySelector('.ag-n')||{}).innerText||''}))""")
    r.ok(len(groups) >= 2, "the apps are grouped under their Heroku account", str(groups))
    r.ok(all(g["n"] for g in groups), "each heading says how many apps are in it", str(groups))
    r.ok([g["name"] for g in groups] == sorted(g["name"] for g in groups),
         "accounts in order", str([g["name"] for g in groups]))
    # ⚠ the grid is shared by head and rows — a heading that spans it must not
    # knock the columns out of line (the v15 subgrid trap)
    r.ok(pg.evaluate("""()=>{const h=document.querySelector('.apptbl-head'),w=document.querySelector('.apptbl-row');
      const a=[...h.children].map(c=>Math.round(c.getBoundingClientRect().left));
      const b=[...w.children].map(c=>Math.round(c.getBoundingClientRect().left));
      return JSON.stringify(a)===JSON.stringify(b);}"""),
         "and every heading still sits over its own column")
    total = pg.locator(".apptbl-row").count()
    first_n = int(groups[0]["n"].split()[0])
    pg.locator(".apptbl-group .tree-tog").first.click(); pg.wait_for_timeout(350)
    r.ok(pg.locator(".apptbl-row").count() == total - first_n,
         "folding an account hides exactly its own apps",
         f"{pg.locator('.apptbl-row').count()} vs {total - first_n}")
    pg.locator(".apptbl-group .tree-tog").first.click(); pg.wait_for_timeout(350)
    r.ok(pg.locator(".apptbl-row").count() == total, "and they come back")

    # ------------------------------------------------------ (1) tags --------
    print("\n-- tags, written once --")
    r.ok(pg.locator(".apptbl-row .tag").count() > 0, "apps carry tags")
    r.ok(pg.locator(".apptbl-row .tag .tag-x").count() ==
         pg.locator(".apptbl-row .tag").count(), "and every one of them has an ×")
    shared = pg.evaluate("""()=>{const m={};document.querySelectorAll('.apptbl-row .tag-t')
        .forEach(t=>{m[t.innerText]=(m[t.innerText]||0)+1;});return m;}""")
    r.ok(any(v > 1 for v in shared.values()),
         "the SAME tag appears on more than one app — that is the point", str(shared))

    pg.locator('[data-act="tag-pick"]').first.click(); pg.wait_for_timeout(500)
    r.ok(pg.locator("#tagDlg[open]").count() == 1, "the Tag button opens the list you already have")
    n_choices = pg.locator(".tagpick .tagbtn").count()
    r.ok(n_choices >= 2, "with the pre-written tags in it", str(n_choices))
    off = pg.locator('.tagpick .tagbtn[aria-pressed="false"]').first
    label = off.locator(".tag-t").inner_text()
    off.click(); pg.wait_for_timeout(1200)
    r.ok(pg.locator(f'.tagpick .tagbtn[aria-pressed="true"] .tag-t').count() >= 1,
         "clicking one puts it on the app")
    r.ok(pg.locator(".tagpick .tagbtn").count() == n_choices,
         "and does NOT make a second copy of the tag", str(pg.locator(".tagpick .tagbtn").count()))
    # the same press takes it off again
    pg.locator(".tagpick .tagbtn", has_text=label).first.click(); pg.wait_for_timeout(1200)
    r.ok(pg.locator(".tagpick .tagbtn", has_text=label).first.get_attribute("aria-pressed") == "false",
         "clicking it again takes it off")

    print("\n-- writing a new one --")
    before = pg.locator(".tagpick .tagbtn").count()
    pg.fill("#tagNewForm input[name=label]", "Do not touch")
    pg.click("#tagNewForm button[type=submit]")
    # ⚠ wait on the ELEMENT: making a tag is three round trips and the offline
    # demo answers the big reads slowly ON PURPOSE, so any fixed sleep here is
    # a coin toss rather than a check.
    r.ok(wait_for(pg, lambda: pg.locator(".tagpick .tagbtn").count() == before + 1, timeout=15000),
         "a new tag joins the list", str(pg.locator(".tagpick .tagbtn").count()))
    r.ok(pg.locator('.tagpick .tagbtn[aria-pressed="true"]', has_text="Do not touch").count() == 1,
         "and lands on the app you were tagging")
    # writing the same words twice must not make a second tag
    pg.fill("#tagNewForm input[name=label]", "Do not touch")
    pg.click("#tagNewForm button[type=submit]")
    r.ok(wait_for(pg, lambda: any("already" in t.lower()
                                  for t in pg.locator(".toast").all_inner_texts()), timeout=15000),
         "writing the same words again says you already have it")
    r.ok(pg.locator(".tagpick .tagbtn", has_text="Do not touch").count() == 1,
         "and never becomes a second tag")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)

    # ------------------------------------------------- (2) one press off ----
    print("\n-- the × --")
    wait_for(pg, lambda: pg.locator(".apptbl-row .tag-x").count() > 0)
    n0 = pg.locator(".apptbl-row .tag").count()
    first_label = pg.locator(".apptbl-row .tag-t").first.inner_text()
    pg.locator(".apptbl-row .tag-x").first.click(); pg.wait_for_timeout(1400)
    r.ok(pg.locator(".apptbl-row .tag").count() == n0 - 1,
         "one press on the × takes that tag off that app",
         f"{pg.locator('.apptbl-row .tag').count()} vs {n0 - 1}")
    # ⚠ and it must NOT delete the tag itself — it is still available to others
    r.ok(pg.locator(".taglist-row .tag-t", has_text=first_label).count() == 1,
         "and the tag itself still exists for every other app", first_label)

    # ------------------------------------------------------ the tag list ----
    print("\n-- the list of tags --")
    rows = pg.locator(".taglist-row").count()
    r.ok(rows >= 3, "every tag is listed once", str(rows))
    uses = pg.evaluate("()=>[...document.querySelectorAll('.tl-uses')].map(x=>x.innerText)")
    r.ok(all("app" in u for u in uses), "each says how many apps carry it", str(uses))
    # deleting a tag for good takes it off every app
    doomed = pg.locator(".taglist-row").first
    dlabel = doomed.locator(".tag-t").inner_text()
    on_rows = pg.locator(".apptbl-row .tag-t", has_text=dlabel).count()
    doomed.locator('[data-act="tag-del"]').click(); pg.wait_for_timeout(1600)
    r.ok(pg.locator(".taglist-row").count() == rows - 1, "deleting removes it from the list")
    r.ok(pg.locator(".apptbl-row .tag-t", has_text=dlabel).count() == 0,
         f"and off all {on_rows} app(s) that carried it")

    # ------------------------------------- tags on a CLOSED tree ----------
    print("\n-- tags when the tree is shut --")
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: pg.locator("#fvPick .ro-acct").count() > 0)
    # ⚠ 31 Aug: the picker opens collapsed since v34. These assertions are about
    # what the tags do when the tree is OPEN, so open it first — the shut case
    # is asserted a few lines below, and in fmclicks.py.
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0)
    pg.wait_for_timeout(300)
    r.ok(pg.locator(".tagrow-folded").count() == 0,
         "nothing extra while the tree is open — the tags are on the apps")
    tgt = pg.locator("#fvPick .ro-repo").filter(
        has=pg.locator(".ro-name", has_text="brightleaf-web")).first
    under = pg.evaluate("""()=>{const rp=[...document.querySelectorAll('#fvPick .ro-repo')]
        .find(x=>/brightleaf-web/.test((x.querySelector('.ro-name')||{}).innerText||''));
        return [...new Set([...rp.querySelectorAll('.ro-app .tag-t')].map(t=>t.innerText))];}""")
    tgt.locator(".tree-tog").first.click(); pg.wait_for_timeout(400)
    r.ok(tgt.locator(".ro-app:visible").count() == 0, "folding hides the apps")
    shown = pg.evaluate("""()=>[...document.querySelectorAll('#fvPick .ro-repo .tagrow-folded .tag-t')]
        .map(t=>t.innerText)""")
    r.ok(sorted(shown) == sorted(under),
         "and their tags come UP onto the closed line — exactly the ones underneath",
         f"{shown} vs {under}")
    r.ok(pg.locator(".tagrow-folded .tag-x").count() == 0,
         "read-only up here: no × that could not say which hidden app it meant")
    # and on the account, one level up
    pg.locator("#fvPick .ro-head .tree-tog").first.click(); pg.wait_for_timeout(400)
    r.ok(pg.locator(".ro-head .tagrow-folded .tag").count() >= 1,
         "folding a whole account brings its tags up too")

    r.ok(not errs, "no page errors in the whole run", str(errs[:3]))
    b.close()
srv.shutdown()
sys.exit(r.done("tags"))
