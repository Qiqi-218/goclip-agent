"""Drive one real conversation turn against an arbitrary DSH port and report what happened."""
import asyncio
import json
import sys
import urllib.request

import websockets

PORT = sys.argv[1] if len(sys.argv) > 1 else '8098'
TOKEN = sys.argv[2]
PROMPT = sys.argv[3] if len(sys.argv) > 3 else '现在有哪些项目？'
BASE = f'http://127.0.0.1:{PORT}'
CDP = 'http://127.0.0.1:9222'


def targets():
    with urllib.request.urlopen(f'{CDP}/json', timeout=10) as r:
        return json.load(r)


class Cdp:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def send(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=90))
            if msg.get('id') == mid:
                return msg.get('result', {})

    async def eval(self, expr):
        r = await self.send('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        return r.get('result', {}).get('value')


async def main():
    page = None
    for t in targets():
        if t.get('type') == 'page' and str(PORT) in (t.get('url') or ''):
            page = t
            break
    if page is None:
        # fall back to whichever page is open
        pages = [t for t in targets() if t.get('type') == 'page']
        if not pages:
            print('NO PAGE TARGET'); return
        page = pages[0]
    print('page:', page.get('url', '')[:90])

    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=None) as ws:
        cdp = Cdp(ws)
        # navigate to the token URL so the session cookie is set
        await cdp.send('Page.navigate', url=f'{BASE}/?token={TOKEN}')
        await asyncio.sleep(6)
        await cdp.eval('location.reload()')
        await asyncio.sleep(7)

        # The composer is a contenteditable div, not a textarea. React listens on
        # input events, so inserting through execCommand notifies it properly.
        typed = await cdp.eval(f'''
        (() => {{
          const el = document.querySelector('[contenteditable="true"]');
          if (!el) return 'no-composer';
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, {json.dumps(PROMPT)});
          el.dispatchEvent(new InputEvent('input', {{bubbles: true, inputType: 'insertText'}}));
          return el.innerText.slice(0, 40);
        }})()
        ''')
        print('type:', typed)
        await asyncio.sleep(1)
        sent = await cdp.eval('''
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          el.focus();
          for (const type of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(type, {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}));
          }
          return 'entered';
        })()
        ''')
        print('submit:', sent)
        print('submitted; waiting for the turn')
        await asyncio.sleep(90)

        text = await cdp.eval("document.body.innerText.slice(-2500)")
        print('--- 页面末尾 ---')
        print(text)


asyncio.run(main())
