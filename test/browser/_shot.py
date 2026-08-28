import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, signin
from playwright.sync_api import sync_playwright
BASE, srv = serve_mock(8701)
OUT = "/tmp/claude-0/-root-workspace/d1630b3a-08ca-4b88-a95e-dc9e224f820f/scratchpad"
os.makedirs(OUT, exist_ok=True)
with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1050}).new_page()
    errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)
    pg.click('.nav-item[href="#/files"]'); pg.wait_for_timeout(1500)
    pg.screenshot(path=OUT+"/fm-pick.png", full_page=True)
    pg.locator(".ro-open").first.click(); pg.wait_for_timeout(2500)
    pg.screenshot(path=OUT+"/fm-open.png", full_page=True)
    pg.click('.nav-item[href="#/repos"]'); pg.wait_for_timeout(2500)
    pg.evaluate("()=>{document.querySelectorAll('input[data-repock]').forEach((c,i)=>{if(i<2)c.click();});}")
    pg.wait_for_timeout(600)
    pg.screenshot(path=OUT+"/repos-sel.png", full_page=True)
    print("errors:", errs[:3] if errs else "none")
    b.close()
srv.shutdown()
