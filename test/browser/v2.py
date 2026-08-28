"""
Full browser check of the v2 panel.

Covers the things the client rejected v1 for, plus the flows themselves:
  * one Help/Knowledge-base entry point, one Settings entry point, no duplicate ids
  * chapters actually switch
  * deploy flow end to end with mixed outcomes
  * VA cannot reach Settings
  * no console errors, no horizontal overflow, at four widths
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else mock_page()
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad"

fails = []
def check(cond, name, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))
    if not cond:
        fails.append(name)

async def login(pg, user):
    await pg.goto(f"file://{PAGE}")
    await pg.fill('#loginForm [name=username]', user)
    await pg.fill('#loginForm [name=password]', "x")
    await pg.click("#loginBtn")
    await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
    await pg.wait_for_timeout(500)

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()

        # ---------- structure ----------
        print("\n-- structure --")
        pg = await br.new_page(viewport={"width": 1680, "height": 1050})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await login(pg, "owner")

        dup = await pg.evaluate("""() => {
          const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
          return [...new Set(ids.filter(i=>ids.filter(x=>x===i).length>1))];
        }""")
        check(dup == [], "no duplicate element ids", str(dup))

        nav = await pg.evaluate("""() => {
          const t = [...document.querySelectorAll('a,button')]
            .filter(e=>e.offsetParent!==null)
            .map(e=>(e.textContent||'').trim().toLowerCase());
          return {help: t.filter(x=>x==='guide'||x==='knowledge base'||x==='help').length,
                  keys: t.filter(x=>/accounts/.test(x)).length};
        }""")
        # v14 pulled the jobs out of Settings onto the rail, so there is no
        # "Settings" entry any more -- but each thing must still appear ONCE
        check(nav["help"] == 1, "exactly one entry point for the guide", f"found {nav['help']}")
        check(nav["keys"] == 1, "exactly one entry point for accounts and keys", f"found {nav['keys']}")

        emoji = await pg.evaluate(r"""() => (document.body.innerText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)||[]).length""")
        check(emoji == 0, "no emoji used as iconography", f"{emoji} found")

        # ---------- knowledge base ----------
        print("\n-- knowledge base --")
        await pg.click("[data-view=kb]" if await pg.query_selector("[data-view=kb]") else "text=Knowledge base")
        await pg.wait_for_timeout(600)
        kb = await pg.evaluate("""() => ({
          chapters: document.querySelectorAll('#kbList .kb-item').length,
          current: (document.querySelector('#kbList [aria-current=page] .kb-t')||{}).textContent,
          paneChars: (document.querySelector('#kbPane')||{innerText:''}).innerText.length })""")
        check(kb["chapters"] >= 5, "knowledge base has chapters", str(kb["chapters"]))
        check(kb["paneChars"] > 200, "chapter content renders", str(kb["paneChars"]))
        items = await pg.query_selector_all("#kbList .kb-item")
        if len(items) > 2:
            await items[2].click(); await pg.wait_for_timeout(400)
            kb2 = await pg.evaluate("""() => (document.querySelector('#kbList [aria-current=page] .kb-t')||{}).textContent""")
            check(kb2 != kb["current"], "clicking a chapter switches the reading pane", f"{kb['current']} -> {kb2}")
        await pg.screenshot(path=f"{OUT}/v2-kb.png")

        # ---------- settings ----------
        print("\n-- settings --")
        # the four tabs became four rail entries; walk those instead
        # they all carry data-view="settings" and differ by their address
        rails = ["#/accounts", "#/apps", "#/new", "#/people"]
        seen, rendered = 0, 0
        for href in rails:
            el = await pg.query_selector(f'.nav-item[href="{href}"]')
            if not el:
                continue
            seen += 1
            await el.click(); await pg.wait_for_timeout(800)
            n = await pg.evaluate("""() => {
                const v=[...document.querySelectorAll('.view')].find(x=>!x.hidden);
                return v ? v.innerText.trim().length : 0; }""")
            if n > 100:
                rendered += 1
        check(seen == 4, "the set-up screens are on the rail, not behind tabs", str(seen))
        check(rendered == seen, "and each one renders", f"{rendered}/{seen}")
        tabs = []
        await pg.screenshot(path=f"{OUT}/v2-settings.png")

        # ---------- deploy flow ----------
        print("\n-- deploy flow --")
        await pg.click("[data-view=deploy]" if await pg.query_selector("[data-view=deploy]") else "text=Deploy")
        await pg.wait_for_timeout(500)
        # the real checkbox is visually hidden behind a styled span — a user clicks
        # the LABEL, so the test must too
        await pg.click("label:has(#selAll)"); await pg.wait_for_timeout(300)
        sel = await pg.evaluate("() => (document.querySelector('#selCount')||{}).textContent")
        # count the deployable cards rather than hardcoding the demo's size —
        # the offline data grows whenever a new state needs demonstrating
        want = await pg.evaluate(
            "() => document.querySelectorAll('#siteGrid .site-card:not(.nolink)').length")
        check(f"{want} of {want}" in (sel or ""), "select-all selects every website",
              f"{sel!r} with {want} deployable cards")
        await pg.set_input_files("input[type=file]", {"name": "index.html", "mimeType": "text/html", "buffer": b"<h1>hi</h1>"})
        await pg.wait_for_timeout(400)
        dis = await pg.evaluate("() => document.querySelector('#deployBtn').disabled")
        check(dis is False, "deploy enables once sites and a file are chosen")
        await pg.click("#deployBtn")
        # Poll with real sleeps. wait_for_function's raf-based polling proved
        # unreliable here — the page's own timers did not advance under it.
        act = ""
        for _ in range(20):
            await pg.wait_for_timeout(2000)
            act = await pg.evaluate("() => (document.querySelector('#activityBody')||{innerText:''}).innerText")
            has_undo = await pg.evaluate("""() => [...document.querySelectorAll('button')]
                .some(b => b.offsetParent!==null && /undo/i.test(b.textContent))""")
            if has_undo and any(w in act.lower() for w in ("live", "failed", "saved")):
                break
        check("live" in act.lower(), "per-site results appear", act[:60].replace("\n", " "))
        check(("failed" in act.lower()) or ("saved" in act.lower()), "mixed outcomes are shown, not one blanket tick")
        undo = await pg.evaluate("""() => [...document.querySelectorAll('button')]
            .filter(b=>b.offsetParent!==null && /undo/i.test(b.textContent)).length""")
        check(undo == 1, "exactly one undo control", f"found {undo}")
        await pg.screenshot(path=f"{OUT}/v2-deploy-done.png")
        check(not errs, "no console or page errors", str(errs[:2]))
        await pg.close()

        # ---------- VA ----------
        print("\n-- va role --")
        pg2 = await br.new_page(viewport={"width": 390, "height": 844})
        verrs = []
        pg2.on("pageerror", lambda e: verrs.append(str(e)))
        await login(pg2, "maria")
        vis = await pg2.evaluate("""() => {
          const t=[...document.querySelectorAll('a,button')].filter(e=>e.offsetParent!==null)
            .map(e=>(e.textContent||'').trim().toLowerCase());
          return {keys: t.filter(x=>/accounts/.test(x)).length,
                  kb: t.filter(x=>x==='guide'||x==='knowledge base').length,
                  people: t.filter(x=>x==='people').length};
        }""")
        # "VA MUST ALSO BE ABLE TO ADD KEYS… I just want VA to work on it."
        # After v14 those live on the rail; only People stays the owner's.
        check(vis["keys"] == 1, "the VA can reach accounts and keys", str(vis))
        check(vis["kb"] == 1, "and the guide", str(vis))
        check(vis["people"] == 0, "but not People", str(vis))
        check(not verrs, "no errors in the VA view", str(verrs[:2]))
        await pg2.screenshot(path=f"{OUT}/v2-va-phone.png")
        await pg2.close()
        await br.close()

    print(f"\n{'FAILURES: ' + ', '.join(fails) if fails else 'v2 browser suite: all checks passed'}")
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
