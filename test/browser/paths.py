"""What he picks is what lands. Deploy and the File Manager, one rule.

Exists because a folder called "assets" arrived as 12 loose files at the top of
the repo: Deploy stripped the picked folder's own name, the File Manager did
not, and neither screen said so.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8690)
r = Run()
ADD = """(rels)=>{addDeployFiles(rels.map(x=>({rel:x,file:new File(['x'],x.split('/').pop())})));}"""
SPY = """()=>{window.__sent=[];const orig=FormData.prototype.append;
  FormData.prototype.append=function(k,v){if(k==='paths')window.__sent.push(v);return orig.apply(this,arguments);};}"""
PICKED = ["assets/ag-press.css", "assets/ag-press.js", "assets/img/logo.webp", "index.html"]

with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1000}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- a picked folder keeps its name --")
    pg.evaluate(ADD, PICKED)
    r.ok(wait_for(pg, lambda: pg.locator(".fl-row").count() == 4), "four files are staged")
    paths = pg.evaluate("()=>[...document.querySelectorAll('.fl-path')].map(x=>x.innerText.trim())")
    r.ok(paths == PICKED, "every path is EXACTLY as picked — nothing stripped, nothing renamed", str(paths))

    print("\n-- Deploy asks where the set lands --")
    r.ok(pg.locator("#landDir").count() == 1, "there is a place to say where")
    r.ok(pg.input_value("#landDir") == "", "empty by default, which means 'exactly as picked'")
    pg.fill("#landDir", "public")
    r.ok(wait_for(pg, lambda: pg.locator(".fl-path").first.inner_text().strip() == "public/assets/ag-press.css"),
         "typing a folder updates every preview live", pg.locator(".fl-path").first.inner_text())
    pg.fill("#landDir", "")
    r.ok(wait_for(pg, lambda: pg.locator(".fl-path").first.inner_text().strip() == "assets/ag-press.css"),
         "clearing it puts them back exactly as picked")

    print("\n-- what is SENT matches what was shown --")
    pg.evaluate(SPY)
    pg.fill("#landDir", "public/")
    pg.wait_for_timeout(300)
    pg.evaluate("()=>{document.querySelector('.site-card input[type=checkbox]').click();}")
    pg.wait_for_timeout(200)
    pg.click("#deployBtn")
    r.ok(wait_for(pg, lambda: pg.evaluate("()=>window.__sent&&window.__sent.length>0")), "the update is sent")
    sent = pg.evaluate("()=>JSON.parse(window.__sent[0])")
    r.ok(sent == ["public/" + p for p in PICKED],
         "the server receives the same paths the screen promised", str(sent))
    r.ok(not errs, "no page errors", str(errs[:2]))
    b.close()
srv.shutdown()
sys.exit(r.done("paths"))
