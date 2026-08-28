"""
A link per screen: refreshing must keep you where you were.

The decisive check is page.reload() - a hash that merely appears in the address
bar and then dumps you on Deploy is the exact complaint this fixes.

    python3 test/browser/v12.py [page.html]
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else mock_page()

fails = []
def ck(c, n, x=""):
    print(("  ok   " if c else "  FAIL ") + n + ((" [" + str(x) + "]") if x and not c else ""))
    if not c: fails.append(n)

async def signin(pg, who="owner"):
    # the session lives in sessionStorage, so a second visit in the same context
    # is already signed in -- waiting for the login form would hang forever
    try:
        await pg.wait_for_selector("#shell:not([hidden])", timeout=1500)
        await pg.wait_for_timeout(500)
        return
    except Exception:
        pass
    await pg.wait_for_selector("#loginForm [name=username]", timeout=20000)
    await pg.fill("#loginForm [name=username]", who)
    await pg.fill("#loginForm [name=password]", "x")
    await pg.click("#loginBtn")
    await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
    await pg.wait_for_timeout(700)

async def visible(pg):
    return await pg.evaluate("""() => [...document.querySelectorAll('.view')]
        .filter(v => !v.hidden).map(v => v.id)""")

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        ctx = await br.new_context(viewport={"width": 1680, "height": 1050})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await pg.goto(f"file://{PAGE}")
        await signin(pg)

        # ---------- the decisive test ----------
        print("\n-- refreshing keeps you where you were --")
        SCREENS = [
            ("#/deploy",                 "view-deploy"),
            ("#/files",                  "view-files"),
            ("#/files/101",              "view-files"),
            ("#/files/101/public",       "view-files"),
            ("#/log",                    "view-log"),
            ("#/accounts",               "view-settings"),
            ("#/apps",                   "view-settings"),
            ("#/people",                 "view-settings"),
            ("#/new",                    "view-settings"),
            ("#/guide/tokens",           "view-kb"),
        ]
        for href, want in SCREENS:
            await pg.evaluate(f"() => {{ location.hash = '{href}'; }}")
            await pg.wait_for_timeout(700)
            await pg.reload()
            await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
            await pg.wait_for_timeout(900)
            vis = await visible(pg)
            got = await pg.evaluate("() => location.hash")
            ck(want in vis and got.startswith(href.split('/')[1] and href[:len(href)]),
               f"{href} survives a reload", f"hash={got} showing={vis}")

        # a folder must come back OPEN, not just the app
        await pg.evaluate("() => { location.hash = '#/files/101/public'; }")
        await pg.wait_for_timeout(800)
        await pg.reload(); await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
        # the tree is fetched after the page settles, so wait for it to arrive
        try:
            await pg.wait_for_function(
                "() => { try { return S && S.fv && S.fv.cwd === 'public'; } catch(e){ return false; } }",
                timeout=20000)
        except Exception:
            pass
        cwd = await pg.evaluate(
            "() => { try { return (S.fv && S.fv.cwd) || ''; } catch(e){ return 'NO-S'; } }")
        app = await pg.evaluate(
            "() => { try { return String((S.fv && S.fv.appId) || ''); } catch(e){ return 'NO-S'; } }")
        ck(cwd == "public", "and a folder reopens at that folder", cwd)
        ck(app == "101", "with that same app open, not the picker", app)

        # old addresses from v12 must not break for anyone who bookmarked one
        print("\n-- the previous addresses still work --")
        for old, want in (("#/settings/accounts", "view-settings"),
                          ("#/settings/apps",     "view-settings"),
                          ("#/settings/create",   "view-settings"),
                          ("#/settings/people",   "view-settings")):
            await pg.evaluate(f"() => {{ location.hash = '{old}'; }}")
            await pg.wait_for_timeout(900)
            vis = await visible(pg)
            now = await pg.evaluate("() => location.hash")
            ck(want in vis, f"{old} still lands on a real screen", f"{now} {vis}")

        # ---------- they are REAL links ----------
        print("\n-- they are real links, not just an address --")
        rail = await pg.evaluate("""() => [...document.querySelectorAll('.nav-item')].map(n => ({
            tag:n.tagName, href:n.getAttribute('href')}))""")
        ck(all(r["tag"] == "A" for r in rail), "every rail entry is an anchor",
           str([r["tag"] for r in rail]))
        ck(all(r["href"] and r["href"].startswith("#/") for r in rail),
           "each carries its own address", str([r["href"] for r in rail]))
        # ctrl-click must NOT be swallowed (that is what open-in-new-tab needs)
        passed = await pg.evaluate("""() => {
          const a=document.querySelector('.nav-item[data-view=log]');
          const ev=new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true});
          a.dispatchEvent(ev);
          return !ev.defaultPrevented;   // left for the browser to handle
        }""")
        ck(passed, "ctrl-click is left to the browser, so open-in-new-tab works")

        # ---------- no hash lands on Deploy ----------
        print("\n-- the ordinary cases --")
        await pg.goto(f"file://{PAGE}")
        await signin(pg)
        vis = await visible(pg)
        ck("view-deploy" in vis, "opening with no address lands on Deploy", str(vis))

        # a stale app must not leave a blank screen
        await pg.evaluate("() => { location.hash = '#/files/999'; }")
        await pg.wait_for_timeout(1200)
        state = await pg.evaluate("""() => ({
            vis:[...document.querySelectorAll('.view')].filter(v=>!v.hidden).map(v=>v.id),
            picker: !!document.querySelector('#fvPick')&&!document.querySelector('#fvPick').hidden,
            text: document.body.innerText })""")
        ck("view-files" in state["vis"], "a deleted app still shows the File Manager", str(state["vis"]))
        ck("no longer" in state["text"].lower() or "pick one" in state["text"].lower(),
           "and says plainly that it is gone")

        ck(not errs, "no console or page errors", str(errs[:3]))
        await ctx.close()

        # ---------- a VA must not reach People by address ----------
        print("\n-- a link cannot get round the rules --")
        ctx2 = await br.new_context(viewport={"width": 1680, "height": 1050})
        pg2 = await ctx2.new_page()
        await pg2.goto(f"file://{PAGE}#/settings/people")
        await signin(pg2, "maria")
        await pg2.wait_for_timeout(1200)
        va = await pg2.evaluate("""() => {
          const t=[...document.querySelectorAll('[data-tab]')].find(b=>/people/i.test(b.textContent));
          return {tabHidden: t?t.hidden:null,
                  body:(document.querySelector('#setBody')||{innerText:''}).innerText.slice(0,120),
                  hash:location.hash};
        }""")
        ck(va["tabHidden"] is not False, "the VA is not shown People", str(va))
        ck("people" not in va["hash"], "and the address is corrected", va["hash"])
        await ctx2.close()

        await br.close()
    print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "v12 routing suite: all checks passed"))
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
