
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
    errs=[]
    async with async_playwright() as p:
        br=await p.chromium.launch()
        # ---- master: settings tabs ----
        pg=await br.new_page(viewport={"width":1280,"height":950})
        pg.on("pageerror", lambda e: errs.append(f"[master] {e}"))
        pg.on("console", lambda m: errs.append(f"[master] {m.text}") if m.type=="error" else None)
        await pg.goto(f"file://{D}/index.html")
        await pg.fill("#loginForm [name=username]","owner"); await pg.fill("#loginForm [name=password]","x"); await pg.click("#loginBtn")
        await pg.wait_for_selector("#shell:not([hidden])", timeout=15000)
        await pg.click("#btn-settings"); await pg.wait_for_timeout(500)
        for i,(tab,label) in enumerate([("tokens","Keys"),("sites","Websites"),("create","Create new"),("users","People")]):
            try:
                await pg.click(f'[data-tab="{tab}"]'); await pg.wait_for_timeout(700)
                await pg.screenshot(path=f"{D}/settings-{tab}.png", full_page=True)
            except Exception as e: errs.append(f"[settings:{tab}] {e}")
        ow=await pg.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth+1")
        if ow: errs.append("[master] horizontal overflow in settings")
        await pg.close()

        # ---- VA: settings must be unreachable ----
        pg2=await br.new_page(viewport={"width":390,"height":844})
        pg2.on("pageerror", lambda e: errs.append(f"[va] {e}"))
        await pg2.goto(f"file://{D}/index.html")
        await pg2.fill("#loginForm [name=username]","maria"); await pg2.fill("#loginForm [name=password]","x"); await pg2.click("#loginBtn")
        await pg2.wait_for_selector("#shell:not([hidden])", timeout=15000)
        vis = await pg2.evaluate("""() => {
            const b=document.querySelector('#btn-settings');
            const st=b?getComputedStyle(b):null;
            return {present:!!b, hidden: b? (b.hidden || st.display==='none' || st.visibility==='hidden') : true, role:S.role};
        }""")
        print("VA settings button:", vis)
        if vis["role"]!="va": errs.append("VA role not applied")
        if vis["present"] and not vis["hidden"]: errs.append("VA can see the Settings button")
        await pg2.screenshot(path=f"{D}/phone-va.png", full_page=True)
        await pg2.close()
        await br.close()
    print("ERRORS:" if errs else "clean: no console/page errors, no overflow")
    for e in errs: print("  -", e)
asyncio.run(main())
