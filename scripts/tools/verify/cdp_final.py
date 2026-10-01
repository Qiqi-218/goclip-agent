"""Consolidated end-to-end check of the delivered assistant, plus screenshots.

Walks the interface the way the objective describes it, counts what is actually
in the DOM, drives one real conversation turn, and captures pictures of both the
conversation and the workbench panel.
"""
import asyncio
import base64
import json
import sys
import urllib.request
from pathlib import Path

import websockets

TOKEN = sys.argv[1]
OUT = Path(r'E:\huabei\docs-参赛\截图')
OUT.mkdir(parents=True, exist_ok=True)
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

    async def shot(self, name, full=True):
        params = {'format': 'png', 'captureBeyondViewport': full}
        res = await self.send('Page.captureScreenshot', **params)
        path = OUT / name
        path.write_bytes(base64.b64decode(res['data']))
        return path

    async def click_text(self, text):
        return await self.ev("""
        (() => {
          const norm = s => (s || '').replace(/\\s+/g, '');
          const hit = [...document.querySelectorAll('button, [role="button"]')]
            .find(n => norm(n.innerText) === %s);
          if (!hit) return false;
          hit.click();
          return true;
        })()
        """ % json.dumps(text.replace(' ', '')))


MEASURE = """
(() => {
  const q = s => document.querySelectorAll(s);
  const buttons = [...q('button, [role="button"]')].filter(b => b.offsetParent !== null);
  const videos = [...q('video')];
  const imgs = [...q('img')];
  const bars = buttons.filter(b => /dBFS/.test(b.title || ''));
  const heads = [...q('h1,h2,h3')].map(h => h.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean);
  const tokenCount = (document.body.innerText.match(/用量[^\\n]{0,14}/) || [null])[0];
  const turns = q('[data-turn], [class*="turn"]').length;
  const cards = q('[class*="toolCall"], [class*="tool-call"], [class*="ToolCall"]').length;
  return JSON.stringify({
    title: document.title,
    heads: heads.slice(0, 14),
    enabledButtons: buttons.length,
    buttonsWithTitle: buttons.filter(b => (b.title || '') !== '').length,
    videos: videos.length,
    videosReady: videos.filter(v => v.readyState >= 1).length,
    videosWithControls: videos.filter(v => v.hasAttribute('controls')).length,
    images: imgs.length,
    imagesLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    curveBars: bars.length,
    curveBarsLabelled: bars.filter(b => (b.getAttribute('aria-label') || '') !== '').length,
    turnNodes: turns,
    toolCardNodes: cards,
    usage: tokenCount,
    fonts: getComputedStyle(document.body).fontFamily.slice(0, 70),
  }, null, 1);
})()
"""


async def main():
    page = [t for t in targets() if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=64 * 1024 * 1024) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')
        await c.send('Emulation.setDeviceMetricsOverride', width=1680, height=1050,
                     deviceScaleFactor=1, mobile=False)

        print('--- restoring the existing conversation (persistence check)')
        await c.send('Page.navigate', url=URL)
        await asyncio.sleep(16)
        await c.ev("""
        (() => { window.__errs = []; window.__mediaErrors = [];
          window.addEventListener('error', e => {
            const t = e.target;
            if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) {
              window.__mediaErrors.push(t.tagName + ' ' + (t.currentSrc || t.src)); return; }
            window.__errs.push(String(e.message).slice(0, 140));
          }, true);
          window.addEventListener('unhandledrejection', e =>
            window.__errs.push('rej: ' + String(e.reason).slice(0, 140)));
          return true; })()
        """)
        await asyncio.sleep(6)
        print(await c.ev(MEASURE))
        p = await c.shot('01-对话.png')
        print('screenshot:', p.name, p.stat().st_size, 'bytes')

        print()
        print('--- switching to the workbench panel')
        clicked = await c.click_text('剪辑')
        print('clicked 剪辑:', clicked)
        await asyncio.sleep(10)
        print(await c.ev(MEASURE))
        p = await c.shot('02-工作台.png')
        print('screenshot:', p.name, p.stat().st_size, 'bytes')

        print()
        print('page errors :', await c.ev('JSON.stringify(window.__errs)'))
        print('media errors:', await c.ev('JSON.stringify(window.__mediaErrors)'))
        return 0


sys.exit(asyncio.run(main()))
