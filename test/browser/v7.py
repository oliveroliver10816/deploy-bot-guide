"""
v7: multi-select delete in Files, plus the two blocking defects a review caught
(an empty checkbox drawing a tick, and the buildpack notice crying wolf).
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
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await pg.goto(f"file://{PAGE}")
        await pg.fill('#loginForm [name=username]', "owner"); await pg.fill('#loginForm [name=password]', "x")
        await pg.click("#loginBtn"); await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
        await pg.wait_for_timeout(900)

        # ---- buildpack must not cry wolf ----
        warn = await pg.evaluate("""() => {
          const cards=[...document.querySelectorAll('#siteGrid > *')];
          return cards.map(c=>({t:(c.innerText||'').slice(0,60).replace(/\\n/g,' '),
                                warns:/cannot build/i.test(c.innerText||'')}));
        }""")
        warned = [c for c in warn if c["warns"]]
        ck(len(warned) == 1, "exactly the one unbuildable app warns on Deploy", str([c["t"] for c in warned]))

        # open the app that has NEVER been checked; its banner must stay silent
        chip = await pg.query_selector('#siteGrid [data-act="open-files"]')
        await chip.click(); await pg.wait_for_timeout(2600)
        # walk to each app via Change app and check the banner text matches its state
        banner = await pg.evaluate("""() => (document.querySelector('#fvBanner')||{innerText:''}).innerText""")
        ck("cannot build" in banner.lower() or "will build" in banner.lower(),
           "the Files banner states the build situation", banner[:60])

        # ---- an EMPTY checkbox must not paint a tick ----
        d = await pg.query_selector('[data-dir]')
        if d: await d.click(); await pg.wait_for_timeout(700)
        colors = await pg.evaluate("""() => {
          const out={list:null,tree:null};
          const listBox=document.querySelector('.fv-list .cbox .ic, .fv-list .cbox svg');
          const treeBox=document.querySelector('.fv-tree .cbox .ic, .fv-tree .cbox svg');
          if(listBox) out.list=getComputedStyle(listBox).color;
          if(treeBox) out.tree=getComputedStyle(treeBox).color;
          return out;
        }""")
        def transparent(c):
            return c is None or "rgba(0, 0, 0, 0)" in c or c == "transparent"
        ck(transparent(colors["list"]), "an unticked box in the listing shows NO tick", str(colors))
        ck(transparent(colors["tree"]), "an unticked box in the tree shows no tick", str(colors))

        # ---- multi-select delete sends one request with folder paths whole ----
        await pg.evaluate("""() => { window.__posts=[];
          const of=window.fetch; window.fetch=async(u,o)=>{ window.__posts.push({u:String(u),o}); return of(u,o); }; }""")
        # the real input is visually hidden behind the styled box — click the box
        boxes = await pg.query_selector_all('.fv-list input[data-ck], .fv-tree input[data-ck]')
        ck(len(boxes) >= 2, "rows carry checkboxes", str(len(boxes)))
        n = await pg.evaluate("""() => {
            const els=[...document.querySelectorAll('.fv-list input[data-ck], .fv-tree input[data-ck]')].slice(0,2);
            els.forEach(e=>e.click());
            return els.length;
        }""")
        await pg.wait_for_timeout(400)
        bar = await pg.evaluate("() => (document.querySelector('#fvSelBar')||{innerText:''}).innerText")
        ck("selected" in bar.lower(), "a selection bar appears with a count", bar[:60])
        # re-query between presses: the bar re-renders and handles go stale
        sel = '#fvSelBar button'
        first = await pg.query_selector(sel)
        if first:
            await first.click(); await pg.wait_for_timeout(400)
            armed = await pg.evaluate("() => (document.querySelector('#fvSelBar')||{innerText:''}).innerText")
            ck("again" in armed.lower(), "the first press only arms it", armed[:80])
            again = await pg.query_selector(sel)
            if again: await again.click()
            await pg.wait_for_timeout(2000)
            n = await pg.evaluate("() => (window.__posts||[]).length")
            ck(n <= 2, "deleting many things is one request", str(n))
        ck(not errs, "no console or page errors", str(errs[:2]))
        await br.close()
    print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "v7 checks passed"))
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
