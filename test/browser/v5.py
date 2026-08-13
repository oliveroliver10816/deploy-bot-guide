"""
The four defects an adversarial review found in v4. Each check reproduces the
original failure, so a regression fails loudly.
"""
import asyncio, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/panelpreview/index.html"
fails = []
def ck(c, n, x=""):
    print(("  ok   " if c else "  FAIL ") + n + ((" [" + str(x) + "]") if x and not c else ""))
    if not c: fails.append(n)

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        pg = await br.new_page(viewport={"width": 1800, "height": 1050})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(f"file://{PAGE}")
        await pg.fill('#loginForm [name=username]', "owner"); await pg.fill('#loginForm [name=password]', "x")
        await pg.click("#loginBtn"); await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
        await pg.wait_for_timeout(900)

        # ---- 2. the deploy card warns before Files is ever opened ----
        warn = await pg.evaluate("""() => document.querySelectorAll('#siteGrid .sc-warn, #siteGrid [data-act="make-deployable"]').length
            || (document.querySelector('#siteGrid')||{innerText:''}).innerText.toLowerCase().split('heroku cannot build').length-1""")
        ck(warn >= 1, "the Deploy card warns about an unbuildable app on first sign-in", str(warn))

        # ---- 1. unsaved text survives another action (was silent data loss) ----
        chip = await pg.query_selector('#siteGrid [data-act="open-files"]')
        await chip.click(); await pg.wait_for_timeout(2500)
        d = await pg.query_selector('[data-dir]')
        if d: await d.click(); await pg.wait_for_timeout(700)
        f = await pg.query_selector('[data-file$=".html"]') or await pg.query_selector('[data-file]')
        await f.click(); await pg.wait_for_timeout(1500)
        ta = await pg.query_selector("#edTa")
        ck(bool(ta), "the editor opened")
        if ta:
            await ta.click()
            await pg.keyboard.type("/*KEEP-ME*/")
            await pg.wait_for_timeout(500)
            # trigger a re-render of the same view — this used to wipe the text
            nf = await pg.query_selector("#fvNewFolder")
            if nf:
                await nf.click(); await pg.wait_for_timeout(400)
                cancel = await pg.query_selector('[data-act="prompt-cancel"], .dlg [data-close], #fvPromptCancel')
                if cancel: await cancel.click()
                else: await pg.keyboard.press("Escape")
                await pg.wait_for_timeout(900)
            still = await pg.evaluate("""() => {
                const t=document.querySelector('#edTa');
                return {inBox: t? t.value.includes('/*KEEP-ME*/') : null,
                        inState: !!(window.S&&S.fv&&S.fv.fileData&&atob(S.fv.fileData.contentB64||'').includes('/*KEEP-ME*/'))};
            }""")
            ck(still["inBox"] or still["inState"], "typing survives another action in the same view", str(still))

        # ---- 3. the app picker is reachable again ----
        ck(bool(await pg.query_selector("#fvChangeApp")), "there is a Change app control")
        btn = await pg.query_selector("#fvChangeApp")
        if btn:
            await btn.click(); await pg.wait_for_timeout(900)
            back = await pg.evaluate("() => (document.querySelector('#fvPick')||{innerHTML:''}).innerHTML.length")
            ck(back > 50, "it brings the app list back", str(back))

        # ---- 4. highlighting can be switched off ----
        pick = await pg.query_selector('[data-open-files]')
        if pick:
            await pick.click(); await pg.wait_for_timeout(2200)
            d2 = await pg.query_selector('[data-dir]')
            if d2: await d2.click(); await pg.wait_for_timeout(600)
            f2 = await pg.query_selector('[data-file$=".html"]') or await pg.query_selector('[data-file]')
            if f2:
                await f2.click(); await pg.wait_for_timeout(1400)
                before = await pg.evaluate("() => document.querySelectorAll('#fvPaneBody span').length")
                t = await pg.query_selector('[data-fv="hl"]')
                ck(bool(t), "there is a colouring switch")
                if t:
                    await t.click(); await pg.wait_for_timeout(1200)
                    after = await pg.evaluate("() => document.querySelectorAll('#fvPaneBody span').length")
                    ck(after < before, "turning it off removes the highlight spans", f"{before} -> {after}")
        ck(not errs, "no console or page errors", str(errs[:2]))
        await br.close()
    print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "v5 defect checks passed"))
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
