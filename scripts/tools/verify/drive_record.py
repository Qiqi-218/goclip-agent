"""Record the interface by driving it and capturing frames through the DevTools protocol.

Window capture through `gdigrab` returns black for a Chrome window because the
browser composites on the GPU and BitBlt cannot read that surface. The protocol's
own screencast is compositor-independent, and it is also what lets the recording
be driven: the same connection clicks the controls and receives the frames, so
the picture and the actions cannot drift apart.

Output is a silent MP4. Narration is added afterwards.
"""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9333
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ''
FRAMES = Path(r'E:\huabei\_market\demo-frames')
FRAMES.mkdir(parents=True, exist_ok=True)


def targets(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/json', timeout=10) as r:
        return json.load(r)


class Cdp:
    def __init__(self, ws):
        self.ws, self.n, self.frames = ws, 0, 0
        self.pending = {}

    async def send(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get('method') == 'Page.screencastFrame':
                p = msg['params']
                (FRAMES / f'{self.frames:05d}.jpg').write_bytes(
                    __import__('base64').b64decode(p['data']))
                self.frames += 1
                await self.ws.send(json.dumps({
                    'id': 900000 + self.frames, 'method': 'Page.screencastFrameAck',
                    'params': {'sessionId': p['sessionId']}}))
                continue
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})

    async def ev(self, expr):
        res = await self.send('Runtime.evaluate', expression=expr, returnByValue=True)
        if 'exceptionDetails' in res:
            d = res['exceptionDetails']
            return 'JS-ERROR: ' + str(d.get('exception', {}).get('description', d))[:200]
        return res.get('result', {}).get('value')

    async def click(self, text):
        return await self.ev("""
        (() => { const norm = s => (s||'').replace(/\\s+/g,'');
          const b = [...document.querySelectorAll('button,[role="button"]')]
            .filter(x => x.offsetParent !== null).find(x => norm(x.innerText) === %s);
          if (!b) return false; b.click(); return true; })()
        """ % json.dumps(text.replace(' ', '')))

    async def typed(self, text):
        return await self.ev("""
        (() => { const box = document.querySelector('[contenteditable="true"]');
          if (!box) return 'no-composer'; box.focus();
          document.execCommand('insertText', false, %s); return 'typed'; })()
        """ % json.dumps(text, ensure_ascii=False))

    async def submit(self):
        return await self.ev("""
        (() => { const norm = s => (s||'').replace(/\\s+/g,' ').trim();
          const s = [...document.querySelectorAll('button,[role="button"]')]
            .filter(b => b.offsetParent !== null)
            .find(b => /发送|Send/i.test(norm(b.getAttribute('aria-label')) || norm(b.title)));
          if (s) { s.click(); return 'clicked'; }
          const box = document.querySelector('[contenteditable="true"]');
          box.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
          return 'enter'; })()
        """)


async def main():
    page = [t for t in targets(PORT) if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=2 ** 26) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')
        await c.send('Emulation.setDeviceMetricsOverride', width=1600, height=900,
                     deviceScaleFactor=1, mobile=False)

        # Scroll back to the top and start a fresh conversation so the picture
        # holds no earlier chat.
        await c.ev('window.scrollTo(0,0)')
        started = await c.click('新会话')
        print('new conversation:', started)
        await asyncio.sleep(3)

        # quality 90 keeps the text legible, which is the whole point of a UI demo.
        await c.send('Page.startScreencast', format='jpeg', quality=90,
                     maxWidth=1600, maxHeight=900, everyNthFrame=1)
        print('screencast started')
        started_at = asyncio.get_event_loop().time()

        async def mark(label):
            print('  %6.1fs  %s' % (asyncio.get_event_loop().time() - started_at, label))

        # Shot 1 — the workbench, before anything is asked (storyboard 镜头 1-3)
        await mark('open the workbench')
        await c.click('剪辑')
        await asyncio.sleep(6)
        await mark('four columns on screen')
        await asyncio.sleep(4)

        # Shot 2 — the loudness curve, hovered and clicked (镜头 3)
        await c.ev("""
        (() => { const b = [...document.querySelectorAll('button[title]')].filter(x => /dBFS/.test(x.title));
          if (b.length) { const m = b[Math.floor(b.length*0.55)]; const r = m.getBoundingClientRect();
            m.dispatchEvent(new MouseEvent('mouseover', {bubbles:true, clientX:r.x+1, clientY:r.y+1})); } })()
        """)
        await mark('hover a measured second')
        await asyncio.sleep(5)

        # Shot 3 — the conversation (镜头 4)
        await mark('back to the conversation')
        await c.click('对话')
        await asyncio.sleep(3)
        await mark('type the request')
        print('   typed:', await c.typed('把有飞碟图片那里剪一下'))
        await asyncio.sleep(2)
        print('   submit:', await c.submit())
        await mark('submitted')

        # Let the turn run. The tool cards are the point of this shot, so the wait
        # is recorded rather than cut: a jump would read as a faked result.
        for i in range(24):
            await asyncio.sleep(5)
            state = await c.ev("""
            (() => { const t = document.body.innerText;
              return JSON.stringify({
                tools: (t.match(/video_[a-z_]+/g)||[]).slice(0,4),
                streaming: /停止|生成中|思考中/.test(t),
              }); })()
            """)
            data = json.loads(state)
            if data['tools']:
                await mark('tool call: ' + ','.join(data['tools']))
            if not data['streaming'] and data['tools']:
                break

        await mark('turn finished')
        await asyncio.sleep(4)
        await c.send('Page.stopScreencast')
        print()
        print('frames captured:', c.frames)
        return 0


sys.exit(asyncio.run(main()))
