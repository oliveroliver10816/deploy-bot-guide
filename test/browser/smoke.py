
# ⚠️ v1 selectors: this suite predates the v2 redesign. The login ids changed
# (#lg-u/#lg-p/#lg-btn -> #loginForm [name=...] / #loginBtn) and it has been
# crashing on the first fill ever since — it was never a green run, it was a
# traceback nobody read. Selectors updated; anything else it asserts about the
# v1 layout is superseded by wide.py / v2.py / v3.py / bounds.py.
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio, sys
from playwright.async_api import async_playwright
D=_os.path.dirname(mock_page())
async def main():
    errs=[]
    async with async_playwright() as p:
        b=await p.chromium.launch()
        for name,w,h in [("desktop",1280,900),("phone",390,844)]:
            pg=await b.new_page(viewport={"width":w,"height":h})
            pg.on("console", lambda m: errs.append(f"[{name}] console.{m.type}: {m.text}") if m.type=="error" else None)
            pg.on("pageerror", lambda e: errs.append(f"[{name}] pageerror: {e}"))
            await pg.goto(f"file://{D}/index.html")
            await pg.wait_for_timeout(400)
            # login
            await pg.fill("#loginForm [name=username]","owner"); await pg.fill("#loginForm [name=password]","x")
            await pg.click("#loginBtn"); await pg.wait_for_timeout(700)
            await pg.screenshot(path=f"{D}/{name}-1-sites.png", full_page=True)
            # select all + continue
            try:
                await pg.click("#selall"); await pg.wait_for_timeout(250)
            except Exception as e: errs.append(f"[{name}] selall: {e}")
            try:
                await pg.click("#nextbtn"); await pg.wait_for_timeout(400)
                await pg.screenshot(path=f"{D}/{name}-2-file.png", full_page=True)
            except Exception as e: errs.append(f"[{name}] next->file: {e}")
            # attach a file
            try:
                await pg.set_input_files("#fpick", {"name":"index.html","mimeType":"text/html","buffer":b"<h1>hi</h1>"})
                await pg.wait_for_timeout(350)
                await pg.click("#nextbtn"); await pg.wait_for_timeout(400)
                await pg.screenshot(path=f"{D}/{name}-3-confirm.png", full_page=True)
            except Exception as e: errs.append(f"[{name}] file->confirm: {e}")
            # deploy and watch
            try:
                await pg.click("#deploybtn"); await pg.wait_for_timeout(4200)
                await pg.screenshot(path=f"{D}/{name}-4-watch.png", full_page=True)
            except Exception as e: errs.append(f"[{name}] deploy: {e}")
            # horizontal overflow?
            ow=await pg.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth+1")
            if ow: errs.append(f"[{name}] HORIZONTAL OVERFLOW")
            await pg.close()
        await b.close()
    print("ERRORS:" if errs else "no console/page errors, no overflow")
    for e in errs: print("  -", e)
asyncio.run(main())
