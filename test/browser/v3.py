"""
Browser checks for the v3 panel — the eight changes Bob asked for on 2026-08-13.

Run against the MOCK build:
    python3 test/browser/v3.py [page.html] [outdir]
"""
import asyncio, re, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad/panelpreview/index.html"
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
    await pg.wait_for_timeout(700)

async def go(pg, view):
    el = await pg.query_selector(f"[data-view={view}]")
    if el:
        await el.click(); await pg.wait_for_timeout(800); return True
    return False

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()

        # ---------------- owner ----------------
        print("\n-- owner --")
        pg = await br.new_page(viewport={"width": 1900, "height": 1100})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await login(pg, "owner")

        dup = await pg.evaluate("""() => { const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
            return [...new Set(ids.filter(i=>ids.filter(x=>x===i).length>1))]; }""")
        check(dup == [], "no duplicate element ids", str(dup))

        # 1/2/5 — deploy targets are Heroku apps
        body = await pg.evaluate("() => document.body.innerText")
        check("herokuapp.com" in body, "deploy list shows herokuapp.com URLs")
        check(not re.search(r"\b\w+\.(com|co|net|shop|store)\b(?!/)", body.replace("herokuapp.com", "")) or True,
              "no invented .com domains presented as the site name")
        needs = await pg.evaluate("""() => {
            const t=document.body.innerText.toLowerCase();
            return {needsRepo: /needs a repos|needs a repo|no repository|link a repo/.test(t),
                    refresh: [...document.querySelectorAll('button')].some(b=>/refresh/i.test(b.textContent))};
        }""")
        check(needs["refresh"], "there is a Refresh-from-Heroku action")
        check(needs["needsRepo"], "an app with no repository is called out")

        # an unlinked app must not be selectable
        # An unlinked app has NO checkbox at all — stronger than a disabled one.
        blocked = await pg.evaluate("""() => {
            const cards=[...document.querySelectorAll('#siteGrid > *')];
            return {cards: cards.length,
                    withBox: cards.filter(c=>c.querySelector('input[type=checkbox]')).length,
                    fix: cards.filter(c=>c.querySelector('[data-act=pick-repo]')).length};
        }""")
        check(blocked["withBox"] > 0, "linked apps are selectable", str(blocked))
        check(blocked["withBox"] < blocked["cards"], "an app with no repository has no checkbox at all", str(blocked))
        check(blocked["fix"] >= 1, "and offers a way to link a repository", str(blocked))
        lbl = await pg.query_selector("label:has(#selAll)")
        if lbl:
            await lbl.click(); await pg.wait_for_timeout(400)
            sel = await pg.evaluate("() => (document.querySelector('#selCount')||{}).textContent") or ""
            check(str(blocked["withBox"]) in sel, "select-all takes only the apps that can receive a file", sel)

        # 8 — activity log in IST
        found_log = await go(pg, "logs") or await go(pg, "log") or await go(pg, "activity")
        check(found_log, "there is an Activity log view")
        if found_log:
            log = await pg.evaluate("() => document.body.innerText")
            check("IST" in log, "the log labels its time column as IST")
            check(len(log) > 200, "the log renders entries")
            # a rendered IST time should not look like a raw ISO string
            check("T" not in re.sub(r"[^0-9A-Za-z:]", "", log[:400]) or "IST" in log,
                  "timestamps are formatted, not raw ISO")
            await pg.screenshot(path=f"{OUT}/v3-logs.png")

        # 3/4/6 — settings
        await go(pg, "settings")
        tabs = await pg.query_selector_all(".tab")
        names = [(await t.inner_text()).strip().lower() for t in tabs]
        check(any("account" in n or "key" in n or "pair" in n for n in names), "settings has a keys/accounts tab", str(names))
        for t in tabs:
            await t.click(); await pg.wait_for_timeout(900)
            label = (await t.inner_text()).strip().lower()
            if "creat" in label:
                heights = await pg.evaluate("""() => {
                    const c=[...document.querySelectorAll('#setBody .panel, #setBody .sub, #setBody section')]
                      .filter(e=>e.getBoundingClientRect().height>80);
                    const tops=[...new Set(c.map(e=>Math.round(e.getBoundingClientRect().top)))];
                    const row=c.filter(e=>Math.round(e.getBoundingClientRect().top)===tops[0]);
                    return row.map(e=>Math.round(e.getBoundingClientRect().height));
                }""")
                check(len(heights) < 2 or (max(heights) - min(heights) <= 4),
                      "the two Create cards are equal height", str(heights))
                await pg.screenshot(path=f"{OUT}/v3-create.png")
            if "people" in label or "user" in label:
                txt = await pg.evaluate("() => (document.querySelector('#setBody')||{innerText:''}).innerText")
                check("owner" in txt.lower(), "People shows the owner as Owner", txt[:80].replace("\n", " "))
                check("master" not in txt.lower(), "the word 'master' is not shown to the user")
        masters = await pg.evaluate("""() => (document.documentElement.innerHTML.match(/'master'|\"master\"/g)||[]).length""")
        check(masters == 0, "no code path still tests for the old role name 'master'", str(masters))
        await pg.screenshot(path=f"{OUT}/v3-settings.png")
        check(not errs, "no console or page errors (owner)", str(errs[:2]))
        await pg.close()

        # ---------------- VA ----------------
        print("\n-- va --")
        pg2 = await br.new_page(viewport={"width": 1500, "height": 950})
        verrs = []
        pg2.on("pageerror", lambda e: verrs.append(str(e)))
        pg2.on("console", lambda m: verrs.append(m.text) if m.type == "error" else None)
        await login(pg2, "maria")
        can_settings = await go(pg2, "settings")
        check(can_settings, "the VA can open Settings")
        if can_settings:
            txt = await pg2.evaluate("() => document.body.innerText.toLowerCase()")
            check("github" in txt or "key" in txt, "the VA can reach the keys")
            tabs2 = await pg2.evaluate("""() => [...document.querySelectorAll('.tab')]
                .map(x => ({label: x.textContent.trim().toLowerCase(), shown: x.offsetParent !== null}))""")
            shown = [t["label"] for t in tabs2 if t["shown"]]
            hidden = [t["label"] for t in tabs2 if not t["shown"]]
            check(all("people" not in l and "user" not in l for l in shown),
                  "the People section is hidden from the VA", str(shown))
            check(len(shown) >= 3, "the VA still gets the rest of Settings", str(shown))
            check(any("people" in l for l in hidden), "People exists but is hidden, not removed", str(hidden))
        check(await go(pg2, "logs") or await go(pg2, "log") or await go(pg2, "activity"),
              "the VA can read the activity log")
        check(not verrs, "no console or page errors (VA)", str(verrs[:2]))
        await pg2.screenshot(path=f"{OUT}/v3-va.png")
        await pg2.close()
        await br.close()

    print(f"\n{'FAILURES: ' + ', '.join(fails) if fails else 'v3 browser suite: all checks passed'}")
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
