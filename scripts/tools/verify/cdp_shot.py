"""Screenshot the newest evidence panel from the live page.

A `getBoundingClientRect` box is not evidence that something is painted: the conversation
keeps tool rows inside collapsible groups, and a collapsed ancestor still reports a box.
So this scrolls the panel into the viewport, samples the box with `elementFromPoint`, and
only captures when the samples actually land inside the panel.
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
  const roots = [...document.querySelectorAll('[data-tool="video_evidence_view"]')];
  if (roots.length === 0) return JSON.stringify({ error: 'no tool row' });
  const root = roots[roots.length - 1];
  const panel = root.querySelector('[class*="panel"]');
  if (!panel) return JSON.stringify({ error: 'no panel element', state: root.getAttribute('data-state') });
  // Un-hide the collapsible group this row sits in: the attribute is what the view
  // uses to collapse, and React's own state follows the click dispatched below.
  let el = panel.parentElement, cleared = 0;
  while (el) {
    if (el.hasAttribute('hidden')) { el.removeAttribute('hidden'); cleared += 1 }
    el = el.parentElement;
  }
  let scroller = panel.parentElement;
  while (scroller) {
    if (scroller.scrollHeight > scroller.clientHeight + 20 && getComputedStyle(scroller).overflowY !== 'visible') break;
    scroller = scroller.parentElement;
  }
  const target = scroller || document.scrollingElement;
  target.scrollTop += panel.getBoundingClientRect().top - 70;
  return JSON.stringify({ cleared, scroller: scroller ? String(scroller.className).slice(0, 30) : null });
})()
'''

CHECK = r'''
(() => {
  const roots = [...document.querySelectorAll('[data-tool="video_evidence_view"]')];
  const panel = roots[roots.length - 1].querySelector('[class*="panel"]');
  const r = panel.getBoundingClientRect();
  let inside = 0, total = 0, blocker = null;
  for (let i = 1; i <= 3; i += 1) {
    for (let j = 1; j <= 3; j += 1) {
      total += 1;
      const hit = document.elementFromPoint(Math.round(r.x + (r.width * i) / 4), Math.round(r.y + (r.height * j) / 4));
      if (hit && panel.contains(hit)) inside += 1;
      else if (blocker === null && hit) blocker = String(hit.className).slice(0, 40);
    }
  }
  return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height, inside, total, blocker, vh: window.innerHeight });
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
            print('panel is mostly not painted at its box; not capturing')
            return
        clip = {'x': max(0, check['x'] - 6), 'y': max(0, check['y'] - 6),
                'width': min(check['width'] + 12, 1560), 'height': min(check['height'] + 12, 860), 'scale': 2}
        result = await send('Page.captureScreenshot', format='png', clip=clip, captureBeyondViewport=False)
        with open(OUT, 'wb') as fh:
            fh.write(base64.b64decode(result['data']))
        print('wrote', OUT, json.dumps(clip))


asyncio.run(main())
