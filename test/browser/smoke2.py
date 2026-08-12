import asyncio
from playwright.async_api import async_playwright
D="/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/panelpreview"
async def main():
    errs=[]
    async with async_playwright() as p:
        br=await p.chromium.launch()
        # ---- master: settings tabs ----
        pg=await br.new_page(viewport={"width":1280,"height":950})
        pg.on("pageerror", lambda e: errs.append(f"[master] {e}"))
        pg.on("console", lambda m: errs.append(f"[master] {m.text}") if m.type=="error" else None)
        await pg.goto(f"file://{D}/index.html")
        await pg.fill("#lg-u","bob"); await pg.fill("#lg-p","x"); await pg.click("#lg-btn")
        await pg.wait_for_selector("#scr-main:not([hidden])", timeout=15000)
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
        await pg2.fill("#lg-u","vera"); await pg2.fill("#lg-p","x"); await pg2.click("#lg-btn")
        await pg2.wait_for_selector("#scr-main:not([hidden])", timeout=15000)
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
