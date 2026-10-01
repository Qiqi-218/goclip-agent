"""Inspect the conversation area so the demo storyboard describes what is really there."""
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


# What the sidebar, the composer and the conversation actually offer. The
# storyboard has to name controls that exist.
SURVEY = """
(() => {
  const vis = n => n.offsetParent !== null;
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const buttons = [...document.querySelectorAll('button, [role="button"]')]
    .filter(vis).map(b => norm(b.innerText) || norm(b.getAttribute('aria-label')) || norm(b.title))
    .filter(Boolean);
  const inputs = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')]
    .map(n => ({ tag: n.tagName, ph: n.getAttribute('placeholder') || '', editable: n.isContentEditable }));
  const uploader = document.querySelector('input[type="file"]');
  return JSON.stringify({
    buttons: [...new Set(buttons)].slice(0, 46),
    inputs,
    hasFileInput: Boolean(uploader),
    fileAccept: uploader ? uploader.accept : null,
    sidebarSections: [...document.querySelectorAll('nav, aside')].map(n => norm(n.innerText).slice(0, 120)).filter(Boolean),
  }, null, 1);
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
        await c.send('Page.navigate', url=URL)
        await asyncio.sleep(17)
        print('--- controls the storyboard may name')
        print(await c.ev(SURVEY))
        p = await c.shot('01-对话.png')
        print('\nscreenshot:', p.name, p.stat().st_size, 'bytes')
        return 0


sys.exit(asyncio.run(main()))
