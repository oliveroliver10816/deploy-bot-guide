import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio, sys
from playwright.async_api import async_playwright
P=mock_page()
O="/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad"
fails=[]
def ck(c,n,x=""):
    print(("  ok   " if c else "  FAIL ")+n+((" ["+str(x)+"]") if x and not c else "")); (fails.append(n) if not c else None)
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch(); pg=await br.new_page(viewport={"width":1800,"height":1050})
        errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
        await pg.goto(f"file://{P}")
        await pg.fill('#loginForm [name=username]',"owner"); await pg.fill('#loginForm [name=password]',"x")
        await pg.click("#loginBtn"); await pg.wait_for_selector("#shell:not([hidden])",timeout=20000)
        await pg.wait_for_timeout(900)

        # click-to-copy
        btn=await pg.query_selector("#siteGrid [data-copy]")
        ck(bool(btn), "app URLs are click-to-copy buttons")
        if btn:
            # there are two copy controls per card (name and URL); check the set
            vals = await pg.evaluate("""() => [...document.querySelectorAll('#siteGrid [data-copy]')]
                .map(e => e.dataset.copy)""")
            ck(any("herokuapp" in v for v in vals), "one of them carries the full URL", str(vals[:3]))
            ck(any("herokuapp" not in v and v for v in vals), "and one carries the app name", str(vals[:3]))
            await pg.context.grant_permissions(["clipboard-read","clipboard-write"])
            await btn.click(); await pg.wait_for_timeout(500)
            body=await pg.evaluate("() => document.body.innerText.toLowerCase()")
            ck("copied" in body, "clicking says it copied")

        # activity names the destination
        txt=await pg.evaluate("() => (document.querySelector('#recentBox')||{innerText:''}).innerText")
        ck("northgate-supply" in txt, "recent activity names WHERE the file went", txt[:70].replace("\n"," "))

        # files view + buildpack banner + editor laziness
        # the app CARD chip, not the rail nav — the rail opens Files with no app picked
        # v10 made every list newest-first, so position is no longer identity:
        # pick the app the assertion is ABOUT (northgate-supply is the one with
        # no buildpack), not whichever card happens to be first.
        chip=await pg.query_selector(
            '#siteGrid [data-act="open-files"][aria-label*="northgate-supply"]'
        ) or await pg.query_selector('#siteGrid [data-act="open-files"]')
        ck(bool(chip), "the app card has a folder chip that opens its files")
        if chip:
            await chip.click(); await pg.wait_for_timeout(3000)
            b=await pg.evaluate("() => document.body.innerText")
            ck("Heroku cannot build" in b or "deployable" in b.lower(), "the buildpack banner is shown")
            tree=await pg.evaluate("""() => ({
                files: document.querySelectorAll('[data-file]').length,
                dirs: document.querySelectorAll('[data-dir]').length })""")
            ck(tree["files"]>=1 and tree["dirs"]>=1, "the repo tree lists the top level", str(tree))
            d=await pg.query_selector('[data-dir]')
            if d:
                await d.click(); await pg.wait_for_timeout(900)
                after=await pg.evaluate("() => document.querySelectorAll('[data-file]').length")
                ck(after>tree["files"], "opening a folder reveals what is inside it", f'{tree["files"]} -> {after}')
            # open a text file -> the editor should appear only now
            f=await pg.query_selector('[data-file$=".html"]')
            if f:
                await f.click()
                # wait for the editor itself; a fixed sleep races the fetch
                try:
                    await pg.wait_for_selector("#edTa", timeout=20000)
                except Exception:
                    pass
                await pg.wait_for_timeout(400)
                ed=await pg.evaluate("""() => ({
                    editor: !!document.querySelector('textarea, .ed'),
                    hl: document.querySelectorAll('.tok, .hl, pre span').length })""")
                ck(ed["editor"], "clicking a file opens the editor", str(ed))
                ck(ed["hl"]>0, "with syntax highlighting", str(ed))
            # a binary file must not open in the editor
            img=await pg.query_selector('[data-file$=".png"]')
            if img:
                await img.click(); await pg.wait_for_timeout(1200)
                b2=await pg.evaluate("() => (document.querySelector('#fvPaneBody')||{innerText:''}).innerText.toLowerCase()")
                isimg=await pg.evaluate("() => !!document.querySelector('.fv-img')")
                ck(isimg or "image" in b2 or "preview" in b2, "an image previews instead of opening in the editor", b2[:60])
            await pg.screenshot(path=O+"/v4-files.png")
        ck(not errs, "no console or page errors", str(errs[:2]))
        await br.close()
    print("\n"+("FAILURES: "+", ".join(fails) if fails else "v4 checks passed"))
    return 1 if fails else 0
sys.exit(asyncio.run(main()))
