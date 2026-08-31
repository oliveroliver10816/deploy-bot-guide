"""31 Aug — his report, first real use of tags:
  "When creating a TAG, if I write text and click on the color, text disappears"
  "if I try to chose from predefined tags, there's no need for extra confirm
   button, make it VERY SIMPLE and EASY to use, and multiple confirmations for
   TAGS isn't needed."

The first is a data-loss bug — a colour press rebuilt the whole dialog. Every
assertion below is written from the seat of someone typing, because that is the
thing no earlier tag test did: it clicked, it never typed first.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8767)
r = Run()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={"width": 1680, "height": 1050}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)
    pg.click('.nav-item[href="#/apps"]'); pg.wait_for_timeout(1200)
    pg.click('[data-act="tw-all"]'); pg.wait_for_timeout(800)
    pg.locator('[data-act="tag-pick"]').first.click()
    wait_for(pg, lambda: pg.locator("#tagDlg").is_visible(), timeout=9000)
    pg.wait_for_timeout(400)

    # ---- THE BUG: type, then pick a colour --------------------------------
    pg.fill('#tagNewForm input[name=label]', "BOCA - 7")
    swatches = pg.locator("#tagDlg [data-tagcolor]")
    r.ok(swatches.count() > 1, "there are colours to pick", str(swatches.count()))
    swatches.nth(2).click(); pg.wait_for_timeout(400)
    kept = pg.input_value('#tagNewForm input[name=label]')
    r.ok(kept == "BOCA - 7", "picking a colour KEEPS what you typed", repr(kept))
    r.ok(swatches.nth(2).get_attribute("aria-pressed") == "true",
         "and the colour you picked is the one shown as picked")
    # every other colour must have let go
    pressed = pg.eval_on_selector_all("#tagDlg [data-tagcolor]",
                                      "e=>e.filter(x=>x.getAttribute('aria-pressed')==='true').length")
    r.ok(pressed == 1, "exactly one colour is selected", str(pressed))
    # try a second colour — the text must still survive
    swatches.nth(1).click(); pg.wait_for_timeout(400)
    r.ok(pg.input_value('#tagNewForm input[name=label]') == "BOCA - 7",
         "and it survives changing your mind about the colour")

    # ---- picking an existing tag: ONE press, no confirmation --------------
    before_dlg = pg.locator("#tagDlg").is_visible()
    chips = pg.locator("#tagDlg [data-tagtoggle]")
    if chips.count():
        chip = chips.first
        was = chip.get_attribute("aria-pressed")
        chip.click(); pg.wait_for_timeout(900)
        now = pg.locator("#tagDlg [data-tagtoggle]").first.get_attribute("aria-pressed")
        r.ok(now != was, "one press flips a tag on or off — nothing else to press", f"{was} -> {now}")
        r.ok(pg.locator("#tagDlg").is_visible(), "and the dialog stays put, so you can pick another")
        # ⚠ the whole point: a half-typed tag must survive picking an existing one
        r.ok(pg.input_value('#tagNewForm input[name=label]') == "BOCA - 7",
             "and what you were typing is still there")
        # and it flips back
        pg.locator("#tagDlg [data-tagtoggle]").first.click(); pg.wait_for_timeout(900)
        r.ok(pg.locator("#tagDlg [data-tagtoggle]").first.get_attribute("aria-pressed") == was,
             "pressing it again puts it back")
    else:
        r.ok(True, "no existing tags in this demo to pick from")

    # ---- no confirm-shaped button ----------------------------------------
    foot = pg.locator("#tagDlg .dlg-actions").inner_text().strip()
    r.ok("Done" not in foot, "the footer does not read as a confirmation", foot)
    r.ok("Close" in foot, "it is a plain Close", foot)

    # ---- Enter makes the tag, no mouse needed -----------------------------
    n_before = pg.locator("#tagDlg [data-tagtoggle]").count()
    pg.click('#tagNewForm input[name=label]')
    pg.keyboard.press("Enter")
    wait_for(pg, lambda: pg.locator("#tagDlg [data-tagtoggle]").count() > n_before, timeout=12000)
    r.ok(pg.locator("#tagDlg [data-tagtoggle]").count() == n_before + 1,
         "Enter alone makes the tag", str(pg.locator("#tagDlg [data-tagtoggle]").count()))
    r.ok(pg.input_value('#tagNewForm input[name=label]') == "",
         "the box clears, ready for the next one")

    r.ok(not errs, "no console errors", str(errs))
    b.close()
srv.shutdown()
sys.exit(r.done("tags, from the typing seat"))
