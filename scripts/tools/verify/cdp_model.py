"""Confirm the composer shows the model this deployment actually calls."""
import asyncio
import base64
import json
import sys
import urllib.request
from pathlib import Path

import websockets

TOKEN = sys.argv[1]
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
            return 'JS-ERROR: ' + str(d.get('exception', {}).get('description', d))[:400]
        return res.get('result', {}).get('value')

    async def shot(self, name):
        res = await self.send('Page.captureScreenshot', format='png', captureBeyondViewport=False)
        p = OUT / name
        p.write_bytes(base64.b64decode(res['data']))
        return p


async def main():
    page = [t for t in targets() if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=64 * 1024 * 1024) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')
        await c.send('Emulation.setDeviceMetricsOverride', width=1600, height=900,
                     deviceScaleFactor=1, mobile=False)
        await c.send('Page.navigate', url=URL)
        await asyncio.sleep(18)

        await c.ev("""
        (() => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
          const hit = [...document.querySelectorAll('button, [role="button"]')]
            .find(n => norm(n.innerText).startsWith('新会话'));
          if (hit) hit.click();
          return Boolean(hit);
        })()
        """)
        await asyncio.sleep(8)

        # The composer names the model it will call; that name has to be the one
        # the service is actually configured to reach.
        print('model shown in composer:', await c.ev("""
        (() => {
          const t = document.body.innerText;
          const m = t.match(/Qwen[^\\n]*|DeepSeek[^\\n]*/);
          return m ? m[0].trim() : '(none found)';
        })()
        """))

        p = await c.shot('01-对话.png')
        print('screenshot:', p.name, p.stat().st_size, 'bytes')
        return 0


sys.exit(asyncio.run(main()))
