"""Select a project in the workbench through its own control, then capture."""
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

    async def shot(self, name):
        res = await self.send('Page.captureScreenshot', format='png', captureBeyondViewport=False)
        path = OUT / name
        path.write_bytes(base64.b64decode(res['data']))
        return path


MEASURE = """
(() => {
  const q = s => document.querySelectorAll(s);
  const buttons = [...q('button, [role="button"]')].filter(b => b.offsetParent !== null);
  const videos = [...q('video')];
  const bars = buttons.filter(b => /dBFS/.test(b.title || ''));
  return JSON.stringify({
    project: (q('select') [0] || {}).selectedOptions ? q('select')[0].selectedOptions[0].text : null,
    heads: [...q('h1,h2,h3')].map(h => h.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
    enabledButtons: buttons.length,
    videos: videos.length,
    videosReady: videos.filter(v => v.readyState >= 3).length,
    withPoster: videos.filter(v => (v.getAttribute('poster') || '') !== '').length,
    durations: videos.map(v => Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null),
    curveBars: bars.length,
    curveBarsLabelled: bars.filter(b => (b.getAttribute('aria-label') || '') !== '').length,
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
        await c.send('Page.reload')
        await asyncio.sleep(16)
        await c.ev("""
        (() => { window.__errs = []; window.__mediaErrors = [];
          window.addEventListener('error', e => {
            const t = e.target;
            if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) {
              window.__mediaErrors.push(t.tagName + ' ' + (t.currentSrc || t.src)); return; }
            window.__errs.push(String(e.message).slice(0, 140)); }, true);
          return true; })()
        """)
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
          const opt = [...sel.options].find(o => o.value === %s || o.text.includes(%s));
          if (!opt) return 'no-option:' + [...sel.options].map(o => o.value).join(',');
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'switched:' + opt.value + ' ' + opt.text;
        })()
        """ % (json.dumps(PROJECT), json.dumps('演示')))
        print('project switch:', switched)
        await asyncio.sleep(12)

        print(await c.ev(MEASURE))
        p = await c.shot('02-工作台.png')
        print('screenshot:', p.name, p.stat().st_size, 'bytes')
        print('page errors :', await c.ev('JSON.stringify(window.__errs)'))
        print('media errors:', await c.ev('JSON.stringify(window.__mediaErrors)'))
        return 0


sys.exit(asyncio.run(main()))
