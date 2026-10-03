"""Bring the newest evidence panel into view and screenshot the viewport around it.

Reports whether the panel is actually painted before capturing: a collapsed tool group
still reports a bounding box, so geometry alone is not evidence.
"""
import asyncio
import base64
import json
import sys
import urllib.request

import websockets

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = sys.argv[1]
OUT = sys.argv[2]

PLACE = r'''
(() => {
  const rows = [...document.querySelectorAll('[data-tool="video_evidence_view"]')];
  if (rows.length === 0) return JSON.stringify({ error: 'no evidence row' });
  const row = rows[rows.length - 1];
  const panel = row.querySelector('[class*="panel"]');
  if (!panel) return JSON.stringify({ error: 'no panel', state: row.getAttribute('data-state') });
  let el = panel.parentElement, cleared = 0;
  while (el) { if (el.hasAttribute('hidden')) { el.removeAttribute('hidden'); cleared += 1 } el = el.parentElement }
  let sc = panel.parentElement;
  while (sc) {
    if (sc.scrollHeight > sc.clientHeight + 20 && getComputedStyle(sc).overflowY !== 'visible') break;
    sc = sc.parentElement;
  }
  const target = sc || document.scrollingElement;
  // Put the panel slightly above centre so conversation context stays in frame.
  target.scrollTop += panel.getBoundingClientRect().top - 120;
  return JSON.stringify({ rows: rows.length, cleared });
})()
'''

CHECK = r'''
(() => {
  const rows = [...document.querySelectorAll('[data-tool="video_evidence_view"]')];
  const panel = rows[rows.length - 1].querySelector('[class*="panel"]');
  const r = panel.getBoundingClientRect();
  let inside = 0, total = 0, blocker = null;
  for (let i = 1; i <= 3; i += 1) for (let j = 1; j <= 3; j += 1) {
    total += 1;
    const hit = document.elementFromPoint(Math.round(r.x + r.width * i / 4), Math.round(r.y + r.height * j / 4));
    if (hit && panel.contains(hit)) inside += 1;
    else if (blocker === null && hit) blocker = String(hit.className).slice(0, 40);
  }
  const sil = panel.querySelector('[class*="silenceBar"]');
  return JSON.stringify({
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    inside, total, blocker,
    ticks: panel.querySelectorAll('[class*="tick"]').length,
    silence: sil ? Math.round(sil.getBoundingClientRect().width) : 0,
    loudPoints: (panel.querySelector('polyline') || {getAttribute:()=>null}).getAttribute('points')?.split(' ').length ?? 0,
    labels: [...panel.querySelectorAll('[class*="labelText"]')].map(e => e.textContent),
  });
})()
'''


async def main():
    with urllib.request.urlopen('http://127.0.0.1:9222/json', timeout=10) as r:
        targets = json.load(r)
    page = next(t for t in targets if t.get('type') == 'page' and str(PORT) in (t.get('url') or ''))
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

        placed = json.loads(await ev(PLACE))
        print('place:', json.dumps(placed, ensure_ascii=False))
        if 'error' in placed:
            return
        await asyncio.sleep(3)
        check = json.loads(await ev(CHECK))
        print('check:', json.dumps(check, ensure_ascii=False))
        if check['inside'] < check['total'] / 2:
            print('panel not painted; not capturing')
            return
        shot = await send('Page.captureScreenshot', format='png')
        with open(OUT, 'wb') as fh:
            fh.write(base64.b64decode(shot['data']))
        print('wrote', OUT)


asyncio.run(main())
