"""Open the WSL server in the browser, screenshot it, and report what is on screen."""
import asyncio
import base64
import json
import sys
import urllib.request

import websockets

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

URL = sys.argv[1]
OUT = sys.argv[2]
CDP = 'http://127.0.0.1:9222'

REPORT = r'''
(() => {
  const out = {};
  out.title = document.title;
  out.url = location.origin + location.pathname;
  out.bodyText = document.body.innerText.slice(0, 1200);
  out.composer = document.querySelectorAll('[contenteditable="true"]').length;
  out.toolRows = document.querySelectorAll('[data-tool]').length;
  out.evidenceRows = document.querySelectorAll('[data-tool="video_evidence_view"]').length;
  out.modelLabel = (() => {
    const el = [...document.querySelectorAll('button,span,div')]
      .find(e => /Qwen|DeepSeek|Omni/i.test(e.textContent || '') && (e.textContent || '').length < 40);
    return el ? el.textContent.trim() : null;
  })();
  // is this the auth failure page?
  out.authPage = document.body.innerText.includes('authentication required');
  return JSON.stringify(out);
})()
'''


async def main():
    with urllib.request.urlopen(f'{CDP}/json', timeout=10) as r:
        targets = json.load(r)
    page = next((t for t in targets if t.get('type') == 'page'), None)
    if page is None:
        print('NO PAGE TARGET')
        return
    print('page before:', (page.get('url') or '')[:80])

    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=None) as ws:
        n = 0

        async def send(method, **params):
            nonlocal n
            n += 1
            mid = n
            await ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=90))
                if msg.get('id') == mid:
                    return msg.get('result', {})

        async def ev(expr):
            r = await send('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
            return r.get('result', {}).get('value')

        await send('Page.navigate', url=URL)
        await asyncio.sleep(14)

        info = json.loads(await ev(REPORT))
        for k, v in info.items():
            if k == 'bodyText':
                continue
            print(f'  {k}: {v}')
        print('--- 页面文字 ---')
        print(info.get('bodyText', '')[:1000])

        shot = await send('Page.captureScreenshot', format='png')
        with open(OUT, 'wb') as fh:
            fh.write(base64.b64decode(shot['data']))
        print('wrote', OUT)


asyncio.run(main())
