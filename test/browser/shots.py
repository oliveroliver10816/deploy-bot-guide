import asyncio, os
from playwright.async_api import async_playwright
D="/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/panelpreview"
OUT="/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/kbshots"
os.makedirs(OUT, exist_ok=True)
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch()
        pg=await br.new_page(viewport={"width":900,"height":800}, device_scale_factor=2)
        async def shot(n, sel="body"):
            el = await pg.query_selector(sel)
            await (el.screenshot(path=f"{OUT}/{n}.png") if el else pg.screenshot(path=f"{OUT}/{n}.png"))
            print("shot", n)
        await pg.goto(f"file://{D}/index.html"); await pg.wait_for_timeout(500)
        # the offline-preview note must not appear in the shipped guide
        await pg.evaluate("()=>{const n=document.querySelector('#demo-note'); if(n) n.hidden=true;}")
        await pg.wait_for_timeout(150)
        await shot("01-login", ".login-card")
        await pg.fill("#lg-u","bob"); await pg.fill("#lg-p","x"); await pg.click("#lg-btn")
        await pg.wait_for_selector("#scr-main:not([hidden])", timeout=20000); await pg.wait_for_timeout(500)
        await shot("02-sites")
        await pg.click("#selall"); await pg.wait_for_timeout(250)
        await shot("03-selected")
        await pg.click("#nextbtn"); await pg.wait_for_timeout(400)
        await shot("04-file")
        await pg.set_input_files("#fpick", {"name":"index.html","mimeType":"text/html","buffer":b"<h1>hi</h1>"})
        await pg.wait_for_timeout(400)
        await shot("05-filechosen")
        await pg.click("#nextbtn"); await pg.wait_for_timeout(400)
        await shot("06-confirm")
        await pg.click("#deploybtn"); await pg.wait_for_timeout(2500)
        await shot("07-progress")
        await pg.wait_for_timeout(9000)
        await shot("08-done")
        # settings
        await pg.click("#btn-settings"); await pg.wait_for_timeout(900)
        await shot("09-keys")
        await pg.click('[data-tab="sites"]'); await pg.wait_for_timeout(1200)
        await shot("10-websites")
        await pg.click("#addsite"); await pg.wait_for_timeout(2500)
        await shot("11-addsite")
        await pg.click('[data-tab="users"]'); await pg.wait_for_timeout(1200)
        await shot("12-people")
        await br.close()
asyncio.run(main())
