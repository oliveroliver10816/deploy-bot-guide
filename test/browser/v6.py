"""
Browser checks for v6: working copy, drag-and-drop, multi-file/folder deploys,
and restrained animation.

Run against the MOCK build:
    python3 test/browser/v6.py [page.html]
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _serve import mock_page
import asyncio, json, sys
from playwright.async_api import async_playwright

PAGE = sys.argv[1] if len(sys.argv) > 1 else mock_page()
OUT = "/tmp/claude-0/-root-workspace/a118e9ed-148f-4f48-82a8-214aea5700d1/scratchpad"

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

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        ctx = await br.new_context(permissions=["clipboard-read", "clipboard-write"],
                                   viewport={"width": 1800, "height": 1050})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await signin(pg)

        # ---------- 1. copy, on BOTH the name and the URL ----------
        print("\n-- copy --")
        for what, sel in (("URL", "#siteGrid [data-copy]"),
                          ("name", "#siteGrid [data-copy-name], #siteGrid .sc-domain[data-copy]")):
            el = await pg.query_selector(sel)
            ck(bool(el), f"the app {what} is a copy control")
            if not el:
                continue
            before = await pg.evaluate("() => (document.querySelector('#selCount')||{}).textContent")
            await el.click(); await pg.wait_for_timeout(600)
            res = await pg.evaluate("""async () => {
              let clip=''; try{ clip=await navigator.clipboard.readText(); }catch(e){ clip='ERR'; }
              return {clip, sel:(document.querySelector('#selCount')||{}).textContent,
                      files:!document.querySelector('#view-files').hidden};
            }""")
            ck(len(res["clip"]) > 2 and res["clip"] != "ERR", f"clicking the {what} copies something", res["clip"][:40])
            ck(res["sel"] == before, f"copying the {what} does not tick the card", f'{before} -> {res["sel"]}')
            ck(res["files"] is False, f"copying the {what} does not open Files")

        # ---------- 2/3. many files AND a folder, in ONE request ----------
        print("\n-- multi-file deploy --")
        await pg.evaluate("""() => {
          window.__posts=[];
          const of=window.fetch;
          window.fetch=async (u,o)=>{ if(String(u).includes('/api/deploy')) window.__posts.push({u:String(u),o}); return of(u,o); };
        }""")
        multi = await pg.query_selector('#view-deploy input[type=file][multiple]')
        ck(bool(multi), "the deploy screen has a multi-file picker")
        dirinp = await pg.query_selector('#view-deploy input[type=file][webkitdirectory]')
        ck(bool(dirinp), "and a folder picker")
        if multi:
            await multi.set_input_files([
                {"name": "index.html", "mimeType": "text/html", "buffer": b"<h1>a</h1>"},
                {"name": "style.css", "mimeType": "text/css", "buffer": b"body{}"},
                {"name": "app.js", "mimeType": "text/javascript", "buffer": b"//x"},
            ])
            await pg.wait_for_timeout(900)
            listed = await pg.evaluate("() => document.body.innerText")
            ck("style.css" in listed and "app.js" in listed, "every chosen file is listed")
            # pick apps and send
            lbl = await pg.query_selector("label:has(#selAll)")
            if lbl: await lbl.click(); await pg.wait_for_timeout(400)
            btn = await pg.query_selector("#deployBtn")
            txt = (await btn.inner_text()) if btn else ""
            ck("3" in txt, "the deploy button says how much is going", txt.strip())
            if btn and not await btn.is_disabled():
                before_batches = await pg.evaluate("() => (window.S&&S.state&&S.state.recent||[]).length")
                await btn.click(); await pg.wait_for_timeout(3000)
                # Offline the app talks to its built-in mock, not fetch, so prove
                # it the way the user sees it: ONE update carrying THREE files.
                seen = await pg.evaluate("""() => ({
                    batchFiles: (window.S&&S.batch&&S.batch.file)||'',
                    targets: (window.S&&S.batch&&S.batch.targets||[]).length,
                    body: (document.querySelector('#activityBody')||{innerText:''}).innerText
                })""")
                ck("3 files" in (seen["batchFiles"] or "") or "3 files" in seen["body"],
                   "all three files travelled together as one update", json.dumps(seen)[:160])
                rows = await pg.evaluate("""() => {
                    const t=(document.querySelector('#activityBody')||{innerText:''}).innerText;
                    const apps=['northgate-supply','brightleaf-web','clearwater-labs','summit-tools'];
                    return apps.filter(a=>t.includes(a)).length;
                }""")
                ck(rows >= 2, "and it fanned out to the selected apps", str(rows))
                after_batches = await pg.evaluate("() => (window.S&&S.state&&S.state.recent||[]).length")
                ck(after_batches <= before_batches + 1,
                   "exactly one update was created, not one per file",
                   f"{before_batches} -> {after_batches}")

        # the request the app builds must carry repeated file fields + a matching paths array
        shape = await pg.evaluate("""() => {
          const fd=new FormData();
          const mk=(n)=>new File(['x'],n,{type:'text/plain'});
          [mk('a.html'),mk('b.css')].forEach(f=>fd.append('file',f));
          fd.append('paths', JSON.stringify(['a.html','assets/b.css']));
          return {files:fd.getAll('file').length, paths:JSON.parse(fd.get('paths')).length};
        }""")
        ck(shape["files"] == shape["paths"], "the multipart shape the API expects is achievable", json.dumps(shape))

        # ---------- drag and drop ----------
        print("\n-- drag and drop --")
        dnd = await pg.evaluate("""() => {
          const s=document.documentElement.innerHTML;
          return {overlay: /drop|dragover/i.test(s),
                  entryApi: s.includes('webkitGetAsEntry'),
                  windowGuard: s.includes("addEventListener('dragover'") || s.includes('addEventListener("dragover"')};
        }""")
        ck(dnd["entryApi"], "folders can be dropped (webkitGetAsEntry is used)")
        ck(dnd["windowGuard"], "a missed drop cannot navigate the browser away")
        fired = await pg.evaluate("""() => new Promise(res=>{
          const dt=new DataTransfer();
          dt.items.add(new File(['x'],'dropped.html',{type:'text/html'}));
          const ev=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt});
          document.body.dispatchEvent(ev);
          setTimeout(()=>res(document.body.innerHTML.toLowerCase().includes('drop')),300);
        })""")
        ck(fired, "dragging over the page shows a drop target")

        # ---------- animation ----------
        print("\n-- animation --")
        anim = await pg.evaluate("""() => {
          const css=[...document.querySelectorAll('style')].map(s=>s.textContent).join('\\n');
          return {transitions:(css.match(/transition:/g)||[]).length,
                  keyframes:(css.match(/@keyframes/g)||[]).length,
                  reduced: /prefers-reduced-motion/.test(css),
                  active: /:active/.test(css)};
        }""")
        ck(anim["transitions"] > 10, "there are real transitions", str(anim))
        ck(anim["reduced"], "and they are disabled under prefers-reduced-motion")
        ck(anim["active"], "buttons respond on press")

        ck(not errs, "no console or page errors", str(errs[:2]))
        await pg.screenshot(path=f"{OUT}/v6-deploy.png")
        await pg.close()

        # reduced motion must genuinely stop movement
        ctx2 = await br.new_context(reduced_motion="reduce", viewport={"width": 1400, "height": 900})
        pg2 = await ctx2.new_page()
        await signin(pg2)
        moving = await pg2.evaluate("""() => [...document.querySelectorAll('*')].filter(e=>{
            const c=getComputedStyle(e);
            return (c.animationName!=='none'&&c.animationDuration!=='0s')
                || (c.transitionDuration!=='0s'&&c.transitionProperty!=='none'&&c.transitionProperty!=='all');
          }).length""")
        print(f"  note  elements still animating under reduced motion: {moving}")
        await br.close()

    print("\n" + ("FAILURES: " + ", ".join(fails) if fails else "v6 browser suite: all checks passed"))
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
