"""v29 — his batch: a real delete question, dates everywhere, a nicer note with
game items, click-to-collapse, and the GITKU loading mark.

Each check exists because he asked for the thing, or because a measurement said
the old behaviour was wrong. Nothing here passes just by rendering.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8744)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1680, "height": 1050})
    pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))

    # ------------------------------------------------- (g) the loading mark
    print("\n-- the GITKU mark --")
    pg.goto(BASE)
    pg.fill("#loginForm input[name=username]", "owner")
    pg.fill("#loginForm input[name=password]", "x")
    pg.click("#loginBtn")
    seen = False
    for _ in range(80):
        if pg.locator("#boot:not([hidden])").count(): seen = True; break
        pg.wait_for_timeout(25)
    r.ok(seen, "it appears after sign-in, before the panel")
    pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
    pg.wait_for_timeout(1500)
    r.ok(pg.locator("#boot").is_hidden(), "and goes when the panel is up")
    # ⚠ the mark must not be a fixed hold: it is bounded by the request
    r.ok(pg.evaluate("()=>document.getAnimations().filter(a=>a.playState==='running').length") == 0,
         "nothing is still animating once the panel is idle")
    r.ok(pg.locator("#navwait").is_hidden(), "and the thin top line is not showing for nothing")
    # the wordmark must actually be VISIBLE — a keyframe with only `from` takes
    # its `to` from the element, which made every letter animate 0 -> 0
    pg.evaluate("()=>bootShow()"); pg.wait_for_timeout(800)
    op = pg.evaluate("()=>getComputedStyle(document.querySelector('.boot-word b')).opacity")
    r.ok(op == "1", "the wordmark is actually drawn, not faded to nothing", op)
    r.ok("GITKU" in pg.locator(".boot-word").inner_text().replace("\n", ""),
         "and it says GITKU", pg.locator(".boot-word").inner_text().replace("\n", ""))
    pg.evaluate("()=>bootHide()"); pg.wait_for_timeout(200)

    # -------------------------------------------------- (c) dates on Apps --
    print("\n-- Created on / Last updated --")
    pg.click('.nav-item[href="#/apps"]')
    wait_for(pg, lambda: pg.locator(".apptbl-row").count() > 0)
    heads = pg.evaluate("()=>[...document.querySelectorAll('.apptbl-head .sortbtn')].map(x=>x.innerText.trim().toLowerCase())")
    r.ok("created on" in heads and "last updated" in heads, "the Apps table has both columns", str(heads))
    align = pg.evaluate("""()=>{const h=document.querySelector('.apptbl-head'),w=document.querySelector('.apptbl-row');
      const a=[...h.children].map(c=>Math.round(c.getBoundingClientRect().left));
      const b=[...w.children].map(c=>Math.round(c.getBoundingClientRect().left));
      return JSON.stringify(a)===JSON.stringify(b);}""")
    r.ok(align, "every heading still sits over its own column")   # the v15 subgrid trap
    # ⚠ `.at-dim` also matches the repo sub-label and the account dash, so this
    # used to pass even when dateCell fabricated a date. Bind it to the two
    # date cells of a row whose vendor dates really are null.
    blanks = pg.evaluate(
        "()=>{const rows=[...document.querySelectorAll('.apptbl-row')];"
        "const bad=[];for(const row of rows){const c=[...row.children];"
        "const made=c[4],chg=c[5];const nm=(row.querySelector('.nm')||{}).innerText||'';"
        "const s=S.state.sites.find(x=>(x.app||x.label)===nm.split('\\n')[0].trim());"
        "if(!s)continue;"
        "if(!s.heroku_created_at&&made.innerText.trim()!=='\u2014')bad.push([nm,'made',made.innerText]);"
        "if(!s.released_at&&chg.innerText.trim()!=='\u2014')bad.push([nm,'changed',chg.innerText]);}"
        "return bad;}")
    r.ok(not blanks,
         "an app with no vendor date shows an em dash in that cell, never a guess",
         str(blanks[:3]))
    # sorting by a date must reorder the ACTUAL rows
    # the table now OPENS on Created on, so that heading is already active —
    # check the opening state, then that a DIFFERENT date column opens desc
    r.ok(pg.evaluate("()=>S.sorts.apps.key") == "made",
         "the table opens sorted by a column that is actually on screen",
         pg.evaluate("()=>S.sorts.apps.key"))
    r.ok(pg.locator('.apptbl-head [data-sortkey="made"][data-on="1"]').count() == 1,
         "so the heading is marked and carries its arrow")
    before = pg.evaluate("()=>[...document.querySelectorAll('.apptbl-row .nm')].map(x=>x.innerText)")
    pg.locator('.apptbl-head [data-sortkey="changed"]').click(); pg.wait_for_timeout(350)
    after = pg.evaluate("()=>[...document.querySelectorAll('.apptbl-row .nm')].map(x=>x.innerText)")
    r.ok(before != after, "clicking Last updated really reorders the rows")
    r.ok(pg.evaluate("()=>S.sorts.apps.dir") == "desc", "and a date column opens newest-first")
    # it must sort by the DATE, not merely change something: with the key
    # functions swapped for the app name, "it reordered" still passed
    want = pg.evaluate(
        "()=>[...S.state.sites].filter(x=>x.released_at)"
        ".sort((a,b)=>String(b.released_at).localeCompare(String(a.released_at)))"
        ".map(x=>x.app||x.label)")
    shown = [x for x in after if x in want]
    r.ok(shown == [x for x in want if x in shown],
         "in true date order, not merely a different order", f"{shown[:3]} vs {want[:3]}")

    print("\n-- and on Repos --")
    pg.click('.nav-item[href="#/repos"]')
    wait_for(pg, lambda: pg.locator(".ltbl-repos .ltbl-row").count() > 0)
    rheads = pg.evaluate("()=>[...document.querySelectorAll('.ltbl-repos .ltbl-head .sortbtn')].map(x=>x.innerText.trim().toLowerCase())")
    r.ok("created on" in rheads and "last updated" in rheads, "the same two columns, same words", str(rheads))
    r.ok(pg.evaluate("()=>document.querySelector('.ltbl-repos .ltbl-row').children.length") ==
         pg.evaluate("()=>document.querySelector('.ltbl-repos .ltbl-head').children.length"),
         "head and row hold the same number of cells")

    # --------------------------------------------------- (f) collapse ------
    print("\n-- click to collapse --")
    t0 = pg.locator(".repotree:visible").count()
    pg.locator(".ltbl-repos .tree-tog").first.click(); pg.wait_for_timeout(300)
    r.ok(pg.locator(".repotree:visible").count() == t0 - 1, "a repo's apps fold away on the Repos screen")
    pg.locator(".ltbl-repos .tree-tog").first.click(); pg.wait_for_timeout(300)
    r.ok(pg.locator(".repotree:visible").count() == t0, "and come back")

    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0)
    pg.wait_for_timeout(300)
    n0 = pg.locator("#fvPick .ro-repo").count()
    pg.locator("#fvPick .ro-head .tree-tog").first.click(); pg.wait_for_timeout(300)
    r.ok(pg.locator("#fvPick .ro-repo").count() < n0, "an account folds in the File Manager")
    r.ok(pg.locator("#fvGrid").is_hidden(),
         "and folding NEVER opens the repo it was folding")     # the mis-click trap
    stored = pg.evaluate("()=>localStorage.getItem('gitku.collapsed')")
    r.ok(stored and "acct:" in stored, "the fold is written down", str(stored))
    folded = pg.locator("#fvPick .ro-repo").count()
    pg.reload()
    wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0, timeout=20000)
    pg.wait_for_timeout(700)
    r.ok(pg.locator("#fvPick .ro-repo").count() == folded,
         "and it survives a reload — not sessionStorage, which is per tab",
         f"{pg.locator('#fvPick .ro-repo').count()} vs {folded}")
    pg.evaluate("()=>{localStorage.removeItem('gitku.collapsed');S.collapsed=null;}")

    # ------------------------------------------ per-file dates, honestly ---
    print("\n-- when each file changed --")
    pg.reload(); wait_for(pg, lambda: pg.locator("#fvPick .ro-repo").count() > 0, timeout=20000)
    pg.locator(".ro-open").first.click()
    wait_for(pg, lambda: pg.locator("#fvTree .tline").count() > 0, timeout=15000)
    pg.wait_for_timeout(500)
    sub = pg.locator(".fvt-sub").inner_text()
    r.ok("last commit" in sub, "the repo header says LAST COMMIT, which is what it is", sub)
    r.ok("last updated" not in sub.lower(),
         "and never calls the branch's commit date a file's date", sub)
    # ⚠ NOT a count — a fallback to the repo's commit date would have kept the
    # counts identical while stamping every file with a date it never earned.
    # Check the exact paths against the map the server actually sent.
    truth = pg.evaluate(
        "()=>{const t=S.fv.fileTimes||{};const out=[];"
        "document.querySelectorAll('#fvTree [data-file]').forEach(b=>{"
        "const p=b.dataset.file,w=b.querySelector('.tree-when');"
        "const shown=!!(w&&w.textContent.trim());"
        "const should=Object.prototype.hasOwnProperty.call(t,p);"
        "if(shown!==should)out.push([p,shown,should]);});return out;}")
    r.ok(not truth,
         "a date appears on exactly the files Gitku has written, and no others",
         str(truth[:3]))
    r.ok(pg.evaluate("()=>Object.keys(S.fv.fileTimes||{}).length") > 0,
         "and the server really sent some")

    # ------------------------------------- (a)(b) the delete question ------
    print("\n-- delete asks first --")
    pg.click("label.rowck:has(#fvSelAll)"); pg.wait_for_timeout(400)
    rows_before = pg.locator("#fvTree [data-ck]").count()
    pg.click("#fvBarDel"); pg.wait_for_timeout(450)
    r.ok(pg.locator("#fvDelDlg[open]").count() == 1, "one press opens a question")
    r.ok(pg.locator("#fvTree [data-ck]").count() == rows_before, "and deletes nothing yet")
    r.ok(pg.locator("#fvDelDlg .del-list li").count() >= 1, "it names what would go")
    r.ok(pg.evaluate("()=>document.activeElement&&document.activeElement.id") == "fvDelNo",
         "with the safe answer under your finger")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    r.ok(pg.locator("#fvDelDlg[open]").count() == 0, "Escape backs out")
    pg.click("#fvBarDel"); pg.wait_for_timeout(350)
    pg.click("#fvDelGo")
    wait_for(pg, lambda: pg.locator("#fvDelDlg[open]").count() == 0, timeout=15000)
    pg.wait_for_timeout(700)
    st = pg.evaluate("""()=>{const d=document.querySelector('#fvBarDel'),l=document.querySelector('#fvBarDl');
      return {delOver:d.scrollWidth-d.clientWidth, dlOver:l.scrollWidth-l.clientWidth,
              busy:d.getAttribute('aria-busy'), icon:!!d.querySelector('use'),
              rows:document.querySelectorAll('#fvTree [data-ck]').length,
              toasts:document.querySelectorAll('.toast').length,
              running:document.getAnimations().filter(a=>a.playState==='running').length};}""")
    r.ok(st["rows"] == 0, "the second press really deletes", str(st))
    # 🛑 the exact defect he reported: busy() wrote a spinner + "Deleting…" into a
    # 34px icon, which drew 22px out of each side and was never cleared
    r.ok(st["delOver"] == 0 and st["dlOver"] == 0,
         "and NOTHING overflows the icon bar afterwards", str(st))
    r.ok(st["busy"] is None and st["icon"], "the trash icon is back and not stuck busy", str(st))
    r.ok(st["toasts"] == 1, "exactly one message about it", str(st))
    r.ok(st["running"] == 0, "and no animation is left turning", str(st))

    # ------------------------------------------- (d)(e) the note ----------
    # v31 SUPERSEDED: the free-text note was replaced by TAGS at his request
    # ("make them as tags... select from pre-written tags"). The behaviour this
    # section used to cover — the colours, the game items, the caret insert —
    # now lives in test/browser/tags.py against the control that replaced it.
    # What is asserted HERE is only that the old control is genuinely gone, so
    # nobody is left with two ways to write the same thing.
    print("\n-- the note is a tag now --")
    pg.click('.nav-item[href="#/apps"]')
    wait_for(pg, lambda: pg.locator(".apptbl-row").count() > 0)
    r.ok(pg.locator('[data-act="note-edit"]').count() == 0,
         "the old free-text note editor is gone from the Apps screen")
    r.ok(pg.locator('[data-act="tag-pick"]').count() > 0,
         "and every app offers a tag instead")
    r.ok(pg.locator(".apptbl-row .tag .tag-x").count() > 0,
         "with a one-press × on each tag — see tags.py for the rest")

    # ------------------------------------- the editor colour guard --------
    print("\n-- colour in the editor --")
    # ⚠ This used to read a constant and never open a file, so restoring the
    # old long-line rule put his exact bug back and the suite still said 44/44.
    # Drive the real decision with his real shape: 19 KB, one 3,799-char line.
    verdict = pg.evaluate(
        "()=>{const line='x'.repeat(3799);"
        "const text=Array(40).fill('<p>ok</p>').join('\\n')+'\\n'+line;"
        "const small={size:19279};const big={size:200000};"
        "return {his:(S.edOff||small.size>ED_PLAIN_BYTES),"
        "        huge:(S.edOff||big.size>ED_PLAIN_BYTES),"
        "        note:edPlainNote(),len:text.length};}")
    r.ok(verdict["his"] is False,
         "a 19 KB file with a 3,799-character line KEEPS its colour", str(verdict))
    r.ok(verdict["huge"] is True,
         "and a genuinely large file still opens as plain text", str(verdict))
    r.ok("long single line" not in verdict["note"],
         "the note no longer blames a long line", verdict["note"])

    r.ok(not errs, "no page errors in the whole run", str(errs[:3]))
    b.close()
srv.shutdown()
sys.exit(r.done("v29"))
