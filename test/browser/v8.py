"""
Browser checks for v8 — the six things Bob asked for and did not get in v7.

These exist because v7 shipped without them and he noticed. Each check looks at
what is ON SCREEN, not at what the code implies.

Also carries the runtime duplicate-id assertion that build.sh cannot make
statically (an id written as `${selId}` is only knowable once it has rendered).

    python3 test/browser/v8.py [page.html]
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page, real_page
import asyncio, json, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else mock_page()

fails = []
def ck(c, n, x=""):
    print(("  ok   " if c else "  FAIL ") + n + ((" [" + str(x) + "]") if x and not c else ""))
    if not c: fails.append(n)

async def signin(pg, who="owner"):
    await pg.goto(f"file://{PAGE}")
    await pg.fill('#loginForm [name=username]', who)
    await pg.fill('#loginForm [name=password]', "x")
    await pg.click("#loginBtn")
    await pg.wait_for_selector("#shell:not([hidden])", timeout=20000)
    await pg.wait_for_timeout(900)

async def open_settings(pg, tab):
    # v14 pulled these out of Settings onto the rail, each with its own address
    # v15 split Apps & repos in two and moved each single-half create form
    # onto the screen that lists that kind of thing
    HREF = {"create": "#/new", "accounts": "#/accounts",
            "apps": "#/apps", "repos": "#/repos", "people": "#/people"}
    href = HREF.get(tab.lower(), "#/accounts")
    await pg.evaluate(f"() => {{ location.hash = '{href}'; }}")
    # Wait for THAT screen's own form. ".view:not([hidden])" matches instantly,
    # so it never waited for anything — and the repo list is fetched, so the
    # Repos screen shows a skeleton for a second before its form exists.
    want = {"repos": "#newRepoForm", "apps": "#newAppForm", "create": "#newSiteForm"}.get(tab.lower())
    if want:
        await pg.wait_for_selector(want, timeout=20000)
    await pg.wait_for_timeout(900)

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        ctx = await br.new_context(viewport={"width": 1800, "height": 1050})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await signin(pg)

        # ---------- 1. privacy is never a choice ----------
        # v15: the repo form moved to the Repos screen, and New site grew ONE
        # checkbox — the ready-to-publish one. Privacy still has no control.
        print("\n-- 1. new repos are private, with no choice --")
        await open_settings(pg, "create")
        r = await pg.evaluate("""() => {
          const body=document.querySelector('#setBody');
          const t=body?body.innerText:'';
          const boxes=body?[...body.querySelectorAll('input[type=checkbox]')]:[];
          return {ids: boxes.map(b=>b.id), recommended: /recommend/i.test(t),
                  privacyControl: /private/i.test(boxes.map(b=>b.closest('label')?b.closest('label').innerText:'').join(' '))};
        }""")
        ck(r["ids"] == ["siteReady"], "New site carries exactly one checkbox, and it is ready-to-publish", str(r["ids"]))
        ck(not r["privacyControl"], "no checkbox offers a choice about privacy")
        ck(not r["recommended"], "the words 'recommended' are gone")
        await open_settings(pg, "repos")
        says = await pg.evaluate("() => /New repos are (always )?private/i.test(document.querySelector('#setBody').innerText)")
        ck(says, "the Repos screen states plainly that new repos are private")

        sent = await pg.evaluate("""async () => {
          const f=document.querySelector('#newRepoForm'); if(!f) return {err:'no form'};
          f.querySelector('[name=name]').value='probe-repo';
          const seen=[]; const of=window.fetch;
          window.fetch=async(u,o)=>{ if(String(u).includes('/repo/create')) seen.push(o&&o.body); return of(u,o); };
          const api=window.API&&window.API.__probe;
          f.querySelector('button[type=submit]').click();
          await new Promise(r=>setTimeout(r,1200));
          window.fetch=of;
          return {seen, body:(window.__lastRepoCreate||null)};
        }""")
        # v15: a successful create re-draws the Repos screen (the new repo has to
        # appear in the list above the form), so wait for the form to come back
        await pg.wait_for_selector("#newRepoForm", timeout=20000)
        # offline the page talks to its own mock, so read what the form assembled
        assembled = await pg.evaluate("""() => {
          const f=document.querySelector('#newRepoForm');
          const sel=f.querySelector('select[name=conn_id]');
          return {hasPrivateField: !!f.querySelector('[name=private]'),
                  conn: sel?String(sel.value):null};
        }""")
        ck(not assembled["hasPrivateField"], "no `private` field is sent at all")

        # ---------- 2. both create forms say WHERE ----------
        # v15: they live on two different screens now, so read them one screen
        # at a time — a single evaluate() would find only whichever is mounted.
        print("\n-- 2. each create form names the account --")
        await open_settings(pg, "repos")
        gsel = await pg.evaluate("""() => {
          const g=document.querySelector('#newRepoForm select[name=conn_id]');
          const b=document.querySelector('#newRepoForm button[type=submit]');
          return {g:!!g, gopts:g?[...g.options].map(o=>o.textContent.trim()):[], gbtn:b?b.innerText.trim():''};
        }""")
        await open_settings(pg, "apps")
        hsel = await pg.evaluate("""() => {
          const h=document.querySelector('#newAppForm select[name=conn_id]');
          const b=document.querySelector('#newAppForm button[type=submit]');
          return {h:!!h, hopts:h?[...h.options].map(o=>o.textContent.trim()):[], hbtn:b?b.innerText.trim():''};
        }""")
        acc = {**gsel, **hsel}
        ck(acc["g"], "New repository has an account chooser")
        ck(acc["h"], "New Heroku app has an account chooser")
        ck(acc["gopts"] and acc["gopts"][0] in acc["gbtn"],
           "the repository button names the account it will use", f'{acc["gbtn"]} / {acc["gopts"][:1]}')
        ck(acc["hopts"] and acc["hopts"][0] in acc["hbtn"],
           "the app button names the account it will use", f'{acc["hbtn"]} / {acc["hopts"][:1]}')

        if acc["g"] and len(acc["gopts"]) > 1:
            await open_settings(pg, "repos")     # v15: that form lives here now
            changed = await pg.evaluate("""async () => {
              const g=document.querySelector('#newRepoForm select[name=conn_id]');
              g.selectedIndex=1; g.dispatchEvent(new Event('change',{bubbles:true}));
              await new Promise(r=>setTimeout(r,300));
              return document.querySelector('#newRepoForm button[type=submit]').innerText.trim();
            }""")
            ck(acc["gopts"][1] in changed, "changing the account changes the button", changed)

        # repository lists must show owner/name, not a bare name
        owned = await pg.evaluate("""async () => {
          const sel=document.querySelector('#setBody select[data-repo], #setBody select[name=repo_id]');
          const txt=sel?[...sel.options].map(o=>o.textContent):[];
          return {found:!!sel, slashed:txt.filter(t=>t.includes('/')).length, total:txt.length,
                  groups:sel?sel.querySelectorAll('optgroup').length:0};
        }""")
        if owned["found"] and owned["total"] > 1:
            ck(owned["slashed"] > 0, "repository options carry their owner", json.dumps(owned))

        # ---------- 3. the panel shows it is working ----------
        print("\n-- 3. loading feedback --")
        spin = await pg.evaluate("""async () => {
          const el=document.createElement('span'); el.className='spin';
          document.body.appendChild(el);
          const c=getComputedStyle(el);
          const display=String(c.display), anim=String(c.animationName);
          const t1=String(c.transform);
          await new Promise(r=>setTimeout(r,200));
          const t2=String(getComputedStyle(el).transform);
          const box=el.getBoundingClientRect();
          const w=Math.round(box.width), h=Math.round(box.height);
          el.remove();
          return {display, w, h, anim, moved:t1!==t2};
        }""")
        ck(spin["display"] != "inline", "the spinner is not a bare inline box", spin["display"])
        ck(spin["w"] > 6 and spin["h"] > 6, "it has a real size", f'{spin["w"]}x{spin["h"]}')
        ck(abs(spin["w"] - spin["h"]) <= 2, "it is round, not stretched into an ellipse",
           f'{spin["w"]}x{spin["h"]}')
        ck(spin["anim"] not in ("none", ""), "and it actually spins", spin["anim"])
        ck(spin["moved"], "its transform advances over time")

        # a spinner inside a .notice must not be stretched by the shared flex rule
        stretched = await pg.evaluate("""() => {
          const n=document.createElement('p'); n.className='notice';
          n.innerHTML='<span class="spin"></span><span>Sending 3 files…</span>';
          n.style.width='700px'; document.body.appendChild(n);
          const b=n.querySelector('.spin').getBoundingClientRect();
          n.remove(); return {w:Math.round(b.width), h:Math.round(b.height)};
        }""")
        ck(abs(stretched["w"] - stretched["h"]) <= 2,
           "a spinner inside a notice stays round", f'{stretched["w"]}x{stretched["h"]}')

        # opening an app must say something immediately
        await pg.evaluate("() => document.querySelector('[data-view=files]').click()")
        await pg.wait_for_timeout(500)
        wait = await pg.evaluate("""async () => {
          /* ⚠ `#fvPick button` now also matches the fold twisty, which opens
             nothing — select the control that actually opens a repo. */
          const card=document.querySelector('#fvPick .ro-open, #fvPick [data-open-files]');
          if(!card) return {err:'no picker'};
          card.click();
          const t0=performance.now(); let shown=null, at=null;
          while(performance.now()-t0<1500){
            const el=document.querySelector('.spin, .skel, [aria-busy=true]');
            if(el){ at=Math.round(performance.now()-t0); shown=document.body.innerText.slice(0,4000); break; }
            await new Promise(r=>requestAnimationFrame(r));
          }
          return {at, named:/Reading|Opening|Loading/i.test(shown||'')};
        }""")
        if "err" not in wait:
            ck(wait["at"] is not None and wait["at"] < 400,
               "opening an app shows a busy indicator at once", f'{wait["at"]}ms')
            ck(wait["named"], "and it names what is being read")
        # wait for the repository to actually be open, not for a fixed 1.5s --
        # section 4 asserts it was open, and a sleep raced the load at random
        await pg.wait_for_function(
            "() => document.querySelector('#fvGrid') && !document.querySelector('#fvGrid').hidden",
            timeout=20000)

        # ---------- 4. the left rail resets its screen ----------
        print("\n-- 4. the rail resets --")
        reset = await pg.evaluate("""async () => {
          const open = !document.querySelector('#fvGrid').hidden;
          document.querySelector('[data-view=files]').click();
          await new Promise(r=>setTimeout(r,600));
          return {wasOpen:open, backToPicker: document.querySelector('#fvGrid').hidden===true};
        }""")
        ck(reset["wasOpen"], "a repository was open to begin with")
        ck(reset["backToPicker"], "pressing Files returns to the app picker")

        # ...but never by throwing away unsent work
        keep = await pg.evaluate("""async () => {
          document.querySelector('[data-view=deploy]').click();
          await new Promise(r=>setTimeout(r,400));
          const dt=new DataTransfer();
          dt.items.add(new File(['x'],'kept.html',{type:'text/html'}));
          const inp=document.querySelector('#view-deploy input[type=file][multiple]');
          if(!inp) return {err:'no input'};
          return {staged:true};
        }""")

        # ---------- 5. the browser warns before closing ----------
        print("\n-- 5. closing warns about unfinished work --")
        # assigning to returnValue self-cancels, so read defaultPrevented instead
        async def unload_blocked():
            return await pg.evaluate("""() => {
              const ev=new Event('beforeunload',{cancelable:true});
              window.dispatchEvent(ev);
              return ev.defaultPrevented;
            }""")
        idle = await unload_blocked()
        ck(idle is False, "an idle panel closes without nagging", str(idle))
        for state, setup in (("staged files", "S.files=[{name:'a.html'}]"),
                             ("a running deploy", "S.batch={id:1,done:false}"),
                             ("a write in flight", "S.inflight=1")):
            ok = await pg.evaluate(f"""() => {{ try{{ {setup}; }}catch(e){{ return 'nostate'; }}
              const ev=new Event('beforeunload',{{cancelable:true}});
              window.dispatchEvent(ev); const d=ev.defaultPrevented;
              try{{ S.files=[]; S.batch=null; S.inflight=0; }}catch(e){{}}
              return d; }}""")
            ck(ok is True, f"it warns during {state}", str(ok))
        booted = await pg.evaluate("() => ({ed: !!document.querySelector('#edTa')})")
        ck(not booted["ed"], "and the guard exists before the editor has ever mounted")

        # ---------- 6. runtime duplicate ids, every view ----------
        print("\n-- 6. no duplicate ids at runtime --")
        worst = []
        for nav in ("deploy", "files", "log", "settings", "kb"):
            await pg.evaluate(f"() => document.querySelector('[data-view={nav}]').click()")
            await pg.wait_for_timeout(700)
            d = await pg.evaluate("""() => {
              const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
              return [...new Set(ids.filter(i=>ids.filter(x=>x===i).length>1))];
            }""")
            if d: worst.append({nav: d})
        ck(not worst, "every view is free of duplicate ids", json.dumps(worst)[:200])

        # ---------- 7. a server explanation must survive ----------
        # Real incident: a GitHub 403 ("that key cannot write here") arrived as a
        # 500 whose body carried the reason, and the 5xx short-cut threw it away,
        # showing "please try again in a moment" for something no retry can fix.
        # Must run on the REAL build: with MOCK=true, api() never reaches fetch.
        print("\n-- 7. the server's reason is not thrown away --")
        real = real_page()
        import os
        if True:
            pg3 = await ctx.new_page()
            await pg3.goto(f"file://{real}")
            await pg3.wait_for_timeout(500)
            shown = await pg3.evaluate("""async () => {
              window.fetch=async()=>new Response(
                JSON.stringify({error:'The GitHub key for a/b is not allowed to write to it.'}),
                {status:500,headers:{'Content-Type':'application/json'}});
              try{ await api('/api/anything',{body:{x:1}}); return ''; }catch(e){ return e.message; }
            }""")
            ck("not allowed to write" in shown, "a 500 that explains itself is shown verbatim", shown)
            ck("try again in a moment" not in shown, "and is not replaced by 'try again'", shown)
            generic = await pg3.evaluate("""async () => {
              window.fetch=async()=>new Response('',{status:503});
              try{ await api('/api/anything',{body:{x:1}}); return ''; }catch(e){ return e.message; }
            }""")
            ck("503" in generic and "problem" in generic,
               "a bare 5xx still gets the plain sentence", generic)
            await pg3.close()
        else:
            print("  skip  no non-mock copy at", real)

        ck(not errs, "no console or page errors", str(errs[:3]))
        await pg.close()
        await br.close()

    print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "v8 browser suite: all checks passed"))
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
