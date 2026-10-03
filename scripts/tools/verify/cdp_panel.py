"""Report what the evidence panel renders, and whether it is actually painted.

`getBoundingClientRect` on an element inside a collapsed tool group still returns a
box, so a probe that only reads geometry can claim a panel is on screen when the
conversation has it hidden. The hit test below samples the box and reports how many
points land inside the panel itself.
"""
import asyncio
import json
import sys
import urllib.request

import websockets

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = sys.argv[1] if len(sys.argv) > 1 else '8098'
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ''
BASE = f'http://127.0.0.1:{PORT}'
CDP = 'http://127.0.0.1:9222'
SEL = '[data-tool="video_evidence_view"]'

REPORT = r'''
(() => {
  // Several calls render several panels; the newest is the last row in the transcript.
  // Reading only the first would report a stale call's output as the current state.
  const roots = [...document.querySelectorAll('[data-tool="video_evidence_view"]')];
  if (roots.length === 0) return JSON.stringify({ found: false });
  const root = roots[roots.length - 1];
  const q = (s) => root.querySelector(s);
  const all = (s) => [...root.querySelectorAll(s)];
  const panel = q('[class*="panel"]');
  const out = { found: true, rows: roots.length, rowIndex: roots.length - 1,
    state: root.getAttribute('data-state'), summary: (q('[class*="summary"]') || {}).textContent || null,
    panel: panel !== null };
  if (!panel) return JSON.stringify(out);
  out.title = (q('[class*="title"]') || {}).textContent || null;
  out.duration = (q('[class*="duration"]') || {}).textContent || null;
  out.completeness = (q('[class*="complete"], [class*="incomplete"]') || {}).textContent || null;
  out.tracks = all('[class*="labelText"]').map(el => {
    const seat = el.parentElement;
    const aside = seat ? seat.querySelector('[class*="labelAside"]') : null;
    return { name: el.textContent, aside: aside ? aside.textContent : null };
  });
  out.spans = {
    loudPolylinePoints: (q('polyline') || { getAttribute: () => null }).getAttribute('points'),
    tick: all('[class*="tick"]').length,
    silenceBar: all('[class*="silenceBar"]').length,
    text: all('[class*="bar_text"]').length,
    segment: all('[class*="segment"]').length,
  };
  out.spans.loudPoints = out.spans.loudPolylinePoints ? out.spans.loudPolylinePoints.split(' ').length : 0;
  delete out.spans.loudPolylinePoints;
  const sil = all('[class*="silenceBar"]')[0];
  out.firstSilence = sil ? (r => ({ left: Math.round(r.left), width: Math.round(r.width) }))(sil.getBoundingClientRect()) : null;
  const seg = all('[class*="segment"]')[0];
  out.firstSegment = seg ? (r => ({ left: Math.round(r.left), width: Math.round(r.width), offAxis: seg.getAttribute('data-off-axis') }))(seg.getBoundingClientRect()) : null;
  out.footer = (q('[class*="footer"]') || {}).textContent || null;
  const s = getComputedStyle(panel);
  out.style = { radius: s.borderRadius, background: s.backgroundColor, borderColor: s.borderTopColor };
  // Paint test: a collapsed ancestor still yields a box.
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
  out.painted = { inside, total, blocker };
  return JSON.stringify(out);
})()
'''


async def main():
    with urllib.request.urlopen(f'{CDP}/json', timeout=10) as r:
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

        if TOKEN:
            await send('Page.navigate', url=f'{BASE}/?token={TOKEN}')
            await asyncio.sleep(10)
        raw = await ev(REPORT)
        print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))


asyncio.run(main())
