"""v29: the repo picker in the File Manager gets its own small icon row —
collapse the accounts, search the tree, re-read it.

⚠ The point of the layout is that the bar and its search box live OUTSIDE #fvPick,
because renderFiles() rewrites #fvPick on every keystroke. If they were inside it,
the input would be destroyed mid-type and focus would jump away. There is a test
for exactly that below, and it is the one that would catch a regression."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _serve import serve_mock, Run, wait_for, signin
from playwright.sync_api import sync_playwright

BASE, srv = serve_mock(8731)
r = Run()

def repos(pg):  return pg.locator("#fvPick .ro-repo").count()
def accts(pg):  return pg.locator("#fvPick .ro-acct").count()

def names(pg):
    return pg.eval_on_selector_all("#fvPick .ro-name", "els=>els.map(e=>e.textContent.trim())")

def search(pg, q, expect):
    """Type a query and wait until the tree shows EXACTLY the repos it should.

    ⚠ THIS HELPER WAS WRONG THREE TIMES, EACH TIME THE SAME WAY: the wait condition
    was already satisfied before the new query rendered, so the assertion read the
    previous screen and passed or failed for the wrong reason.
      1. `repos(pg)==1` — true from the search before it.
      2. the "1 of 5 repos" count line — identical for two different queries.
      3. `"cedarpoint-site" in text` — that repo is on screen in the UNFILTERED tree too.
    Only an EXACT match of the rendered set can distinguish "filtered to this" from
    "not filtered yet". See memory [[a-test-that-cannot-fail-is-not-a-test]]."""
    want = sorted(expect)
    pg.fill("#fvPkSearch", q)
    got = wait_for(pg, lambda: sorted(names(pg)) == want)
    assert got, f"search {q!r} wanted {want} but the tree showed {sorted(names(pg))}"
    return names(pg)


with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1680, "height": 1100}); pg = ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    signin(pg, BASE)

    print("\n-- the bar is there, and it is minimal --")
    pg.click('.nav-item[href="#/files"]')
    wait_for(pg, lambda: repos(pg) > 0)
    r.ok(pg.locator("#fvPickPanel").is_visible(), "the picker panel is shown")
    r.ok(pg.locator("#fvPickBar").is_visible(), "the icon row sits above the tree")
    n_btn = pg.locator("#fvPickBar .iconbtn").count()
    r.ok(n_btn == 3, "exactly three buttons — collapse, search, refresh", f"got {n_btn}")
    r.ok(pg.locator("#fvPickBar .iconbtn:not([title])").count() == 0,
         "every button says what it does on hover")
    r.ok(pg.locator("#fvPickBar .iconbtn:not([aria-label])").count() == 0,
         "and every button is named for a screen reader")
    r.ok(not pg.locator("#fvPkSearchWrap").is_visible(), "the search box starts hidden behind its icon")
    base_repos, base_accts = repos(pg), accts(pg)
    r.ok(base_repos == 5 and base_accts == 3, "the tree starts full",
         f"{base_repos} repos / {base_accts} accounts")

    print("\n-- collapse --")
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) == 0)
    r.ok(repos(pg) == 0, "collapsing hides every repo")
    r.ok(accts(pg) == base_accts, "but the accounts stay, so you can still see where things live")
    r.ok(pg.get_attribute("#fvPkCollapse", "aria-pressed") == "true", "the button reports itself pressed")
    r.ok("Expand" in (pg.get_attribute("#fvPkCollapse", "title") or ""),
         "and now offers the opposite action", pg.get_attribute("#fvPkCollapse", "title"))
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) == base_repos)
    r.ok(repos(pg) == base_repos, "pressing again brings them all back")

    print("\n-- search --")
    pg.click("#fvPkFind")
    wait_for(pg, lambda: pg.locator("#fvPkSearchWrap").is_visible())
    r.ok(pg.locator("#fvPkSearchWrap").is_visible(), "the search icon reveals the box")
    r.ok(pg.evaluate("()=>document.activeElement.id") == "fvPkSearch", "and puts the cursor in it")

    ALL = ["brightleaf-web", "cedarpoint-site", "clearwater-labs",
           "northgate-site", "summit-tools-marketing-site"]
    search(pg, "cedar", ["cedarpoint-site"])
    r.ok(names(pg) == ["cedarpoint-site"], "typing a repo name narrows the tree to it alone", str(names(pg)))
    r.ok(pg.inner_text("#fvPkCount").strip() == "1 of 5 repos",
         "and the count says how much is hidden", pg.inner_text("#fvPkCount"))

    search(pg, "northgate-operations-group", ["summit-tools-marketing-site"])
    r.ok(accts(pg) == 1, "an ACCOUNT name finds its repos, and drops the other accounts", str(accts(pg)))

    search(pg, "mirror", ["brightleaf-web"])
    r.ok(names(pg) == ["brightleaf-web"],
         "an APP name finds the repo that feeds it, even though the names differ", str(names(pg)))

    search(pg, "zzzznothing", [])
    r.ok(pg.locator("#fvPick .empty").count() == 1,
         "no match says so instead of leaving an empty space")
    r.ok(pg.inner_text("#fvPkCount").strip() == "0 of 5 repos", "and the count agrees")

    search(pg, "", ALL)
    r.ok(sorted(names(pg)) == ALL, "clearing the box brings every repo back", str(names(pg)))

    print("\n-- the layout trap: typing must not lose the cursor --")
    pg.fill("#fvPkSearch", "")
    pg.click("#fvPkSearch")
    for ch in "brig":
        pg.keyboard.type(ch); pg.wait_for_timeout(160)   # longer than the 120ms debounce
    r.ok(pg.evaluate("()=>document.activeElement.id") == "fvPkSearch",
         "focus survives a re-render mid-word")
    r.ok(pg.input_value("#fvPkSearch") == "brig", "and every letter arrived",
         pg.input_value("#fvPkSearch"))

    print("\n-- search beats collapse --")
    pg.fill("#fvPkSearch", "")
    wait_for(pg, lambda: repos(pg) == base_repos)
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) == 0)
    pg.fill("#fvPkSearch", "cedar")
    wait_for(pg, lambda: repos(pg) == 1)
    r.ok(repos(pg) == 1, "a search opens the tree back up — a hit is never hidden by a collapse")
    pg.fill("#fvPkSearch", "")
    wait_for(pg, lambda: repos(pg) == 0)
    r.ok(repos(pg) == 0, "clearing the search returns to the collapsed state it was in")
    pg.click("#fvPkCollapse")
    wait_for(pg, lambda: repos(pg) == base_repos)

    print("\n-- escape, and refresh --")
    pg.click("#fvPkSearch"); pg.keyboard.type("cedar"); pg.wait_for_timeout(200)
    pg.keyboard.press("Escape")
    wait_for(pg, lambda: repos(pg) == base_repos)
    r.ok(pg.input_value("#fvPkSearch") == "", "Escape empties the box")
    r.ok(not pg.locator("#fvPkSearchWrap").is_visible(), "and puts it away")
    r.ok(repos(pg) == base_repos, "leaving the whole tree showing again")

    pg.click("#fvPkRefresh")
    wait_for(pg, lambda: repos(pg) == base_repos and not pg.locator("#fvPkRefresh").is_disabled())
    r.ok(repos(pg) == base_repos, "refresh re-reads and the tree is still whole")
    r.ok(not pg.locator("#fvPkRefresh").is_disabled(), "and the button frees itself again")

    print("\n-- it belongs to the picker only --")
    pg.click("#fvPick .ro-open")
    wait_for(pg, lambda: pg.locator("#fvGrid").is_visible())
    r.ok(not pg.locator("#fvPickPanel").is_visible(),
         "opening a repo takes the picker and its bar away")
    r.ok(pg.locator("#fvBar").is_visible(), "and the file list's own bar takes over")

    r.ok(not errs, "no page errors", str(errs[:2]))

srv.shutdown()
sys.exit(r.done("pickerbar"))
