import asyncio
from playwright.async_api import async_playwright
D="/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/panelpreview"
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch(); pg=await br.new_page(viewport={"width":390,"height":844})
        await pg.goto(f"file://{D}/index.html")
        await pg.fill("#lg-u","bob"); await pg.fill("#lg-p","x"); await pg.click("#lg-btn")
        await pg.wait_for_selector("#scr-main:not([hidden])", timeout=20000); await pg.wait_for_timeout(600)
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
