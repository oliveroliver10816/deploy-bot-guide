"""v35 — Home: the landing screen, a Go-to dropdown that reaches everything, and
the day book.

His words: "a Home page ... that has links to everything in a dropdown list
where I'd want to go (file manager, app or that repo)" and "some kind of daily
diary that captures everything and records how many sites were used, and
actually we also delete some apps everyday, so it will be out log file too".
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8764)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={"width": 1680, "height": 1050}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    # ---- it is the landing screen ---------------------------------------
    wait_for(pg, lambda: not pg.locator("#view-home").is_hidden(), timeout=9000)
    r.ok(not pg.locator("#view-home").is_hidden(), "signing in lands on Home, not on Deploy")
    r.ok(pg.locator('.nav-item[href="#/home"]').count() == 1, "and Home is in the rail")
    wait_for(pg, lambda: pg.locator(".hm-card").count() > 0)

    # ---- full width, not a centred column (his standing rule) -----------
    w = pg.evaluate("""()=>{const e=document.querySelector('#hmBody .panel');
        return e?Math.round(e.getBoundingClientRect().width):0}""")
    r.ok(w > 1100, "the screen uses the width it is given", f"{w}px of 1680")

    # ---- the counts are links, and they are the real counts -------------
    cards = pg.eval_on_selector_all(".hm-card", """e=>e.map(x=>({
        n:x.querySelector('.hm-n').innerText, l:x.querySelector('.hm-l').innerText,
        href:x.getAttribute('href')}))""")
    r.ok(len(cards) >= 3, "there are counts to read", str(cards))
    r.ok(all(c["href"] for c in cards), "every count is a way in", str(cards))
    apps_card = next(c for c in cards if "app" in c["l"])
    pg.click('.nav-item[href="#/apps"]'); pg.wait_for_timeout(900)
    pg.click('[data-act="tw-all"]'); pg.wait_for_timeout(700)
    real = pg.locator(".apptbl-row").count()
    r.ok(str(real) == apps_card["n"], "and the app count matches the Apps screen",
         f"home {apps_card['n']} vs apps {real}")
    pg.click('.nav-item[href="#/home"]'); pg.wait_for_timeout(900)

    # ---- Go to: everything is reachable ---------------------------------
    opts = pg.eval_on_selector_all("#hmJump option", "e=>e.map(x=>x.value).filter(Boolean)")
    groups = pg.eval_on_selector_all("#hmJump optgroup", "e=>e.map(x=>x.label)")
    r.ok("Screens" in groups and any("App" in g for g in groups) and "Repos" in groups,
         "the dropdown offers screens, apps and repos", str(groups))
    r.ok(any(o.startswith("#/files/") for o in opts),
         "naming an app takes you to ITS FILES, not a list", str(opts[:8]))
    target = next(o for o in opts if o.startswith("#/files/"))
    pg.select_option("#hmJump", target); pg.wait_for_timeout(1500)
    r.ok(not pg.locator("#view-files").is_hidden(), "picking one actually goes there")
    r.ok(pg.eval_on_selector("#hmJump", "e=>e.value") == "",
         "and the dropdown resets, so the same place can be picked twice")
    pg.click('.nav-item[href="#/home"]'); pg.wait_for_timeout(900)

    # ---- the day book -----------------------------------------------------
    facts = pg.locator(".hm-facts").inner_text()
    r.ok(bool(facts.strip()), "the day reports itself with nothing typed in", facts[:120])
    r.ok(pg.locator("#hmDay option").count() >= 1, "there is a day to pick")
    before = pg.locator(".hm-note").count()
    pg.fill("#hmNote", "swapped the hero image")
    pg.click("#hmNoteForm button[type=submit]")
    wait_for(pg, lambda: pg.locator(".hm-note").count() > before, timeout=12000)
    r.ok(pg.locator(".hm-note").count() == before + 1, "a note is written into the day")
    r.ok("swapped the hero image" in pg.locator(".hm-note").last.inner_text(),
         "in his own words", pg.locator(".hm-note").last.inner_text()[:80])
    r.ok(pg.input_value("#hmNote") == "", "and the box clears, ready for the next one")

    # it must survive leaving the screen and coming back
    pg.click('.nav-item[href="#/log"]'); pg.wait_for_timeout(600)
    pg.click('.nav-item[href="#/home"]'); pg.wait_for_timeout(1400)
    r.ok("swapped the hero image" in (pg.locator(".hm-notes").inner_text() if pg.locator(".hm-notes").count() else ""),
         "it is still there when you come back")

    # remove it again
    n_now = pg.locator(".hm-note").count()
    pg.locator('.hm-note [data-act="rm-diary"]').last.click()
    wait_for(pg, lambda: pg.locator(".hm-note").count() < n_now, timeout=12000)
    r.ok(pg.locator(".hm-note").count() == n_now - 1, "and it can be taken back out")

    # ---- an empty note is refused ---------------------------------------
    pg.fill("#hmNote", "   ")
    pg.click("#hmNoteForm button[type=submit]"); pg.wait_for_timeout(900)
    r.ok(pg.locator(".hm-note").count() == n_now - 1, "an empty note writes nothing",
         str(pg.locator(".hm-note").count()))

    r.ok(not errs, "no console errors", str(errs))
    b.close()
srv.shutdown()
sys.exit(r.done("home + day book"))
