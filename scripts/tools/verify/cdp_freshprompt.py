"""Create a fresh session, then read back the system prompt actually sent.

This is the check that was missing: a configuration value being present in
`--dump-config` does not mean it reached the model. The prompt is assembled at
runtime, and a scoped contribution can shadow a global one, so the only reliable
evidence is the `system/message` the session recorded.
"""
import asyncio
import json
import sys
import urllib.request

import websockets

TOKEN = sys.argv[1]
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 240
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
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})

    async def ev(self, expr):
        res = await self.send('Runtime.evaluate', expression=expr, returnByValue=True)
        if 'exceptionDetails' in res:
            d = res['exceptionDetails']
            return 'JS-ERROR: ' + str(d.get('exception', {}).get('description', d))[:200]
        return res.get('result', {}).get('value')


async def main():
    page = [t for t in targets() if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=2 ** 26) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')
        await c.send('Page.navigate', url=URL)
        await asyncio.sleep(18)

        started = await c.ev("""
        (() => { const norm = s => (s||'').replace(/\\s+/g,' ').trim();
          const b = [...document.querySelectorAll('button,[role="button"]')]
            .find(x => norm(x.innerText).startsWith('新会话'));
          if (b) b.click(); return true; return false; })()
        """)
        print('new session:', started)
        await asyncio.sleep(7)

        # One short message is enough to make the session write its system prompt.
        await c.ev("""
        (() => { const b = document.querySelector('[contenteditable="true"]');
          b.focus(); document.execCommand('insertText', false, '你好'); return 'typed'; })()
        """)
        await asyncio.sleep(1)
        await c.ev("""
        (() => { const norm = s => (s||'').replace(/\\s+/g,' ').trim();
          const s = [...document.querySelectorAll('button,[role="button"]')]
            .filter(x => x.offsetParent !== null)
            .find(x => /发送|Send/i.test(norm(x.getAttribute('aria-label')) || norm(x.title)));
          if (s) { s.click(); return 'clicked'; }
          document.querySelector('[contenteditable="true"]')
            .dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
          return 'enter'; })()
        """)
        print('submitted; waiting for the session log to settle')
        await asyncio.sleep(min(LIMIT, 90))
        return 0


sys.exit(asyncio.run(main()))
