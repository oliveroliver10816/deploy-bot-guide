
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
O="/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad"
async def main():
    errs=[]
    async with async_playwright() as p:
        br=await p.chromium.launch()
        for role,user,w,h in [("owner","owner",1100,900),("va","maria",390,844)]:
            pg=await br.new_page(viewport={"width":w,"height":h})
            pg.on("pageerror", lambda e: errs.append(f"[{role}] {e}"))
            pg.on("console", lambda m: errs.append(f"[{role}] {m.text}") if m.type=="error" else None)
            await pg.goto(f"file://{D}/index.html")
            await pg.fill("#loginForm [name=username]",user); await pg.fill("#loginForm [name=password]","x"); await pg.click("#loginBtn")
            await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
            # Help must be reachable for BOTH roles
            vis = await pg.evaluate("()=>{const b=document.querySelector('#btn-help');return !!b && !b.hidden && getComputedStyle(b).display!=='none';}")
            print(f"{role}: Help button visible = {vis}")
            if not vis: errs.append(f"[{role}] Help button not visible")
            await pg.click("#btn-help"); await pg.wait_for_timeout(700)
            shown = await pg.evaluate("()=>!document.querySelector('#scr-help').hidden")
            # screenshots are loading="lazy": scroll the whole page first or the
            # ones below the fold look "broken" when they simply have not loaded
            await pg.evaluate('''async()=>{ const h=document.body.scrollHeight;
              for(let y=0;y<h;y+=400){ window.scrollTo(0,y); await new Promise(r=>setTimeout(r,50)); }
              window.scrollTo(0,0); }''')
            await pg.wait_for_timeout(800)
            imgs = await pg.evaluate("""()=>{const a=[...document.querySelectorAll('.kbshot')];
                return {count:a.length, broken:a.filter(i=>!i.complete||i.naturalWidth===0).length};}""")
            print(f"{role}: help shown={shown} screenshots={imgs}")
            if imgs["count"]==0: errs.append(f"[{role}] no screenshots in KB")
            if imgs["broken"]>0: errs.append(f"[{role}] {imgs['broken']} broken screenshots")
            await pg.screenshot(path=f"{O}/kb-{role}.png", full_page=False)
            ow=await pg.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth+1")
            if ow: errs.append(f"[{role}] horizontal overflow in KB")
            # jump link
            await pg.click('a[href="#kb-trouble"]'); await pg.wait_for_timeout(500)
            # back returns to the deploy screen
            await pg.click("#btn-help-back"); await pg.wait_for_timeout(500)
            back = await pg.evaluate("()=>!document.querySelector('#shell').hidden")
            print(f"{role}: back to main = {back}")
            if not back: errs.append(f"[{role}] Back did not return to the deploy screen")
            await pg.close()
        await br.close()
    print("ERRORS:" if errs else "KB clean: no errors, no broken images, no overflow")
    for e in errs: print("  -", e)
asyncio.run(main())
