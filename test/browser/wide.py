"""
Ultrawide + responsive check.

The client rejected v1 for being "a mobile sized website" on a 34" monitor, so this
measures how much of the viewport the interface actually uses at each width and
fails anything that leaves the screen mostly empty.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else mock_page()
OUT  = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad"
SIZES = [("ultrawide", 3440, 1440), ("desktop", 1680, 1050), ("laptop", 1280, 800), ("phone", 390, 844)]

async def main():
    fails = []
    async with async_playwright() as p:
        br = await p.chromium.launch()
        for name, w, h in SIZES:
            pg = await br.new_page(viewport={"width": w, "height": h})
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            await pg.goto(f"file://{PAGE}")
            # the sign-in form is rendered by script, so wait for it rather than
            # racing it -- v10's mock answers slowly on purpose
            await pg.wait_for_selector('#loginForm [name=username]', timeout=20000)
            await pg.fill('#loginForm [name=username]', "owner")
            await pg.fill('#loginForm [name=password]', "x")
            await pg.click("#loginBtn")
            try:
                await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
            except Exception:
                fails.append(f"{name}: never reached the main screen"); await pg.close(); continue
            await pg.wait_for_timeout(900)

            m = await pg.evaluate("""() => {
              const vw = document.documentElement.clientWidth;
              // widest painted element that is not the page wrapper itself
              let widest = 0, tag = '';
              for (const el of document.querySelectorAll('main,section,div,ul,table,form,header')) {
                const r = el.getBoundingClientRect();
                if (r.height > 60 && r.width > widest && r.width <= vw + 2) { widest = r.width; tag = el.className || el.tagName; }
              }
              // how far right does ANY visible content reach
              let far = 0;
              for (const el of document.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
                  far = Math.max(far, Math.min(r.right, vw));
              }
              // how far DOWN painted content reaches — full width with everything
              // crammed into the top strip is the same complaint on the other axis
              const vh = document.documentElement.clientHeight;
              let low = 0;
              for (const el of document.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
                  low = Math.max(low, Math.min(r.bottom, vh));
              }
              return { vw, vh, widest: Math.round(widest), widestTag: String(tag).slice(0,40),
                       far: Math.round(far), low: Math.round(low),
                       scrollW: document.documentElement.scrollWidth };
            }""")
            used = m["far"] / m["vw"]
            over = m["scrollW"] > m["vw"] + 1
            usedV = m["low"] / m["vh"]
            status = (f"{name:10} {w}x{h}  width {used*100:3.0f}%  height {usedV*100:3.0f}%"
                      f"  widest block {m['widest']}px [{m['widestTag']}]")
            print(status)
            if over: fails.append(f"{name}: horizontal overflow ({m['scrollW']}px > {m['vw']}px)")
            if w >= 1680 and used < 0.90:
                fails.append(f"{name}: only uses {used*100:.0f}% of a {w}px screen — client rejected v1 for exactly this")
            if h >= 900 and usedV < 0.75:
                fails.append(f"{name}: content stops at {usedV*100:.0f}% of a {h}px-tall screen — everything crammed in the top strip")
            if errs: fails.append(f"{name}: js errors {errs[:2]}")
            await pg.screenshot(path=f"{OUT}/wide-{name}.png", full_page=False)
            await pg.close()
        await br.close()
    print("\nFAILURES:" if fails else "\nresponsive: PASS at every width")
    for f in fails: print("  -", f)
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
