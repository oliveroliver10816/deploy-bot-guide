
# ⚠️ v1 selectors: this suite predates the v2 redesign. The login ids changed
# (#lg-u/#lg-p/#lg-btn -> #loginForm [name=...] / #loginBtn) and it has been
# crashing on the first fill ever since — it was never a green run, it was a
# traceback nobody read. Selectors updated; anything else it asserts about the
# v1 layout is superseded by wide.py / v2.py / v3.py / bounds.py.
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio
from playwright.async_api import async_playwright
D=_os.path.dirname(mock_page())
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch(); pg=await br.new_page(viewport={"width":390,"height":844})
        await pg.goto(f"file://{D}/index.html")
        await pg.fill("#loginForm [name=username]","owner"); await pg.fill("#loginForm [name=password]","x"); await pg.click("#loginBtn")
        await pg.wait_for_selector("#shell:not([hidden])", timeout=20000); await pg.wait_for_timeout(600)
        r = await pg.evaluate("""()=>{
          const vw=document.documentElement.clientWidth;
          const bad=[...document.querySelectorAll('*')].filter(el=>{
            const b=el.getBoundingClientRect();
            return b.width>0 && (b.right>vw+1);
          }).slice(0,8).map(el=>({
            tag:el.tagName, id:el.id, cls:(el.className||'').toString().slice(0,40),
            right:Math.round(el.getBoundingClientRect().right), w:Math.round(el.getBoundingClientRect().width),
            txt:(el.textContent||'').trim().slice(0,26)
          }));
          return {vw, scrollW:document.documentElement.scrollWidth, bad};
        }""")
        print("viewport:", r["vw"], "scrollWidth:", r["scrollW"])
        for b in r["bad"]: print("  overflow:", b)
        await br.close()
asyncio.run(main())
