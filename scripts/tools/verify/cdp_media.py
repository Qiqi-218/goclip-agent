"""Verify which media URLs actually deliver bytes, independent of load timing."""
import asyncio
import base64
import json
import sys
import urllib.request
from pathlib import Path

import websockets

TOKEN = sys.argv[1]
PROJECT = sys.argv[2] if len(sys.argv) > 2 else 'proj-demo'
OUT = Path(r'E:\huabei\docs-参赛\截图')
URL = 'http://127.0.0.1:8099/?token=' + TOKEN


def targets():
    with urllib.request.urlopen('http://127.0.0.1:9222/json', timeout=10) as r:
        return json.load(r)


class Cdp:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def send(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError('%s: %s' % (method, msg['error']))
                return msg.get('result', {})

    async def ev(self, expr, await_promise=False):
        res = await self.send('Runtime.evaluate', expression=expr,
                              returnByValue=True, awaitPromise=await_promise)
        if 'exceptionDetails' in res:
            d = res['exceptionDetails']
            return 'JS-ERROR: ' + str(d.get('exception', {}).get('description', d))[:300]
        return res.get('result', {}).get('value')

    async def shot(self, name, full=False):
        res = await self.send('Page.captureScreenshot', format='png', captureBeyondViewport=full)
        p = OUT / name
        p.write_bytes(base64.b64decode(res['data']))
        return p


# Ask the browser itself to fetch each URL the panel is showing. A <video>
# element stays at readyState 0 until the browser decides to buffer, so its state
# says nothing about whether the URL serves bytes. A fetch does.
FETCH_ALL = """
(async () => {
  const urls = new Set();
  for (const v of document.querySelectorAll('video')) {
    if (v.currentSrc) urls.add(v.currentSrc + '|video');
    const p = v.getAttribute('poster');
    if (p) urls.add(p + '|poster');
  }
  const out = [];
  for (const item of urls) {
    const [url, kind] = item.split('|');
    try {
      const r = await fetch(url, { headers: { range: 'bytes=0-2047' } });
      const buf = await r.arrayBuffer();
      out.push({ kind, status: r.status, bytes: buf.byteLength,
                 path: url.replace('http://127.0.0.1:8090', '').slice(0, 78) });
    } catch (e) {
      out.push({ kind, status: 'ERR ' + String(e.message).slice(0, 50), bytes: 0, path: url.slice(0, 78) });
    }
  }
  return JSON.stringify(out, null, 1);
})()
"""


async def main():
    page = [t for t in targets() if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=64 * 1024 * 1024) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')
        await c.send('Emulation.setDeviceMetricsOverride', width=1600, height=900,
                     deviceScaleFactor=1, mobile=False)
        await c.send('Page.reload')
        await asyncio.sleep(16)
        await c.ev("""
        (() => {
          const norm = s => (s || '').replace(/\\s+/g, '');
          const hit = [...document.querySelectorAll('button, [role="button"]')]
            .find(n => norm(n.innerText) === '剪辑');
          if (hit) hit.click();
          return Boolean(hit);
        })()
        """)
        await asyncio.sleep(8)
        switched = await c.ev("""
        (() => {
          const sel = document.querySelector('select');
          if (!sel) return 'no-select';
          const opt = [...sel.options].find(o => o.value === %s);
          if (!opt) return 'no-option';
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'switched:' + opt.text;
        })()
        """ % json.dumps(PROJECT))
        print('project:', switched)
        await asyncio.sleep(14)

        print()
        print('--- does every URL the panel shows actually serve bytes?')
        print(await c.ev(FETCH_ALL, await_promise=True))

        print()
        print('--- poster attribute present on the finished cut?')
        print(await c.ev("""
        (() => JSON.stringify([...document.querySelectorAll('video')].map(v => ({
          poster: (v.getAttribute('poster') || '').replace('http://127.0.0.1:8090',''),
          controls: v.hasAttribute('controls'),
        })), null, 1))()
        """))

        p = await c.shot('02-工作台.png')
        print('\nscreenshot:', p.name, p.stat().st_size, 'bytes')
        return 0


sys.exit(asyncio.run(main()))
