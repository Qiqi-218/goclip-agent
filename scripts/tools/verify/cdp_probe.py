"""Send several prompts through the real UI and print each answer, to probe edge behaviour."""
import asyncio
import json
import sys
import urllib.request

import websockets

PORT = sys.argv[1]
TOKEN = sys.argv[2]
PROMPTS = json.loads(sys.argv[3])
BASE = f'http://127.0.0.1:{PORT}'


def targets():
    with urllib.request.urlopen('http://127.0.0.1:9222/json', timeout=10) as r:
        return json.load(r)


async def main():
    pages = [t for t in targets() if t.get('type') == 'page']
    pg = next((t for t in pages if str(PORT) in (t.get('url') or '')), pages[0])
    async with websockets.connect(pg['webSocketDebuggerUrl'], max_size=None) as ws:
        n = 0

        async def ev(expr, timeout=120):
            nonlocal n
            n += 1
            mid = n
            await ws.send(json.dumps({'id': mid, 'method': 'Runtime.evaluate',
                                      'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
                if m.get('id') == mid:
                    return m.get('result', {}).get('result', {}).get('value')

        for p in PROMPTS:
            before = await ev("document.body.innerText.length")
            await ev(f'''
            (() => {{
              const el = document.querySelector('[contenteditable="true"]');
              el.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, {json.dumps(p)});
              el.dispatchEvent(new InputEvent('input', {{bubbles: true, inputType: 'insertText'}}));
              return 'ok';
            }})()''')
            await asyncio.sleep(0.6)
            await ev('''
            (() => {
              const el = document.querySelector('[contenteditable="true"]');
              el.focus();
              for (const t of ['keydown','keypress','keyup'])
                el.dispatchEvent(new KeyboardEvent(t, {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
              return 'sent';
            })()''')
            # wait for the answer to settle: body text stops growing
            last, stable = -1, 0
            for _ in range(60):
                await asyncio.sleep(3)
                now = await ev("document.body.innerText.length")
                if now == last:
                    stable += 1
                    if stable >= 3:
                        break
                else:
                    stable = 0
                last = now
            text = await ev("document.body.innerText")
            print('\n' + '=' * 70)
            print('提问:', p)
            print('-' * 70)
            print(text[-1600:])


asyncio.run(main())
