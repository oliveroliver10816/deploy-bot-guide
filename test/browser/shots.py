"""Capture knowledge-base screenshots from the current design (mock data)."""
import asyncio, os, sys
from playwright.async_api import async_playwright
P = sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/panelpreview/index.html"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/kbshots"
os.makedirs(OUT, exist_ok=True)

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        pg = await br.new_page(viewport={"width": 1500, "height": 940}, device_scale_factor=2)
        async def shot(n, sel=None):
            el = await pg.query_selector(sel) if sel else None
            await (el.screenshot(path=f"{OUT}/{n}.png") if el else pg.screenshot(path=f"{OUT}/{n}.png"))
            print("shot", n)
        await pg.goto(f"file://{P}"); await pg.wait_for_timeout(500)
        await pg.evaluate("()=>{const n=document.querySelector('#demoNote'); if(n) n.hidden=true;}")
        await shot("01-login", "#auth")
        await pg.fill('#loginForm [name=username]', "owner"); await pg.fill('#loginForm [name=password]', "x")
        await pg.click("#loginBtn"); await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
        await pg.wait_for_timeout(700)
        await shot("02-sites")
        await pg.click("label:has(#selAll)"); await pg.wait_for_timeout(300)
        await pg.set_input_files("input[type=file]", {"name": "summer-sale.html", "mimeType": "text/html", "buffer": b"<h1>hi</h1>"})
        await pg.wait_for_timeout(500)
        await shot("05-filechosen")
        await shot("06-confirm")
        await pg.click("#deployBtn")
        for _ in range(20):
            await pg.wait_for_timeout(2000)
            t = await pg.evaluate("() => (document.querySelector('#activityBody')||{innerText:''}).innerText")
            u = await pg.evaluate("""() => [...document.querySelectorAll('button')].some(b=>b.offsetParent!==null&&/undo/i.test(b.textContent))""")
            if u and any(w in t.lower() for w in ("live", "failed", "saved")): break
        await shot("08-done")
        await pg.click("[data-view=settings]"); await pg.wait_for_timeout(800)
        await shot("09-keys")
        tabs = await pg.query_selector_all(".tab")
        if len(tabs) > 1:
            await tabs[1].click(); await pg.wait_for_timeout(2500); await shot("11-addsite")
        if len(tabs) > 3:
            await tabs[3].click(); await pg.wait_for_timeout(1200); await shot("12-people")
        await br.close()
asyncio.run(main())
