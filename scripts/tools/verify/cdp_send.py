"""Send one composer prompt over CDP and return once it is submitted.

The composer is a Lexical `contenteditable`. `document.execCommand('insertText')`
silently does nothing on it: the editor's innerText stays empty and Enter submits an
empty message. The text has to arrive as a real protocol-level insertion.
"""
import asyncio
import json
import sys
import urllib.request

import websockets

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = sys.argv[1]
TOKEN = sys.argv[2]
PROMPT = sys.argv[3]
BASE = f'http://127.0.0.1:{PORT}'
CDP = 'http://127.0.0.1:9222'


async def main():
    with urllib.request.urlopen(f'{CDP}/json', timeout=10) as r:
        targets = json.load(r)
    page = next(t for t in targets if t.get('type') == 'page' and str(PORT) in (t.get('url') or ''))
    print('page:', (page.get('url') or '')[:90])

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
            await asyncio.sleep(8)

        await ev('document.querySelector(\'[contenteditable="true"]\').focus()')
        await send('Input.insertText', text=PROMPT)
        await asyncio.sleep(1)
        typed = await ev('(() => { const el = document.querySelector(\'[contenteditable="true"]\'); return el.innerText.slice(0, 40) + " | len=" + el.innerText.length })()')
        print('typed:', typed)
        await asyncio.sleep(1)
        await ev('''
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          el.focus();
          for (const type of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(type, {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}));
          }
          return 'entered';
        })()
        ''')
        print('submitted')


asyncio.run(main())
