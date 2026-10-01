"""Drive one real conversation turn and confirm the assistant calls a tool."""
import asyncio
import json
import sys
import urllib.request

import websockets

TOKEN = sys.argv[1]
PROMPT = sys.argv[2] if len(sys.argv) > 2 else '现在有哪些项目？'
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
            return 'JS-ERROR: ' + str(d.get('exception', {}).get('description', d))[:400]
        return res.get('result', {}).get('value')


SEND = """
(() => {
  const box = document.querySelector('[contenteditable="true"]');
  if (!box) return 'no-composer';
  box.focus();
  // The composer is a rich text field; typing through it keeps whatever
  // listeners the shell installed, unlike assigning innerText.
  document.execCommand('insertText', false, %s);
  return 'typed';
})()
"""

SUBMIT = """
(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const send = [...document.querySelectorAll('button, [role="button"]')]
    .filter(b => b.offsetParent !== null)
    .find(b => /发送|Send/i.test(norm(b.getAttribute('aria-label')) || norm(b.title)));
  if (!send) {
    const box = document.querySelector('[contenteditable="true"]');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'enter-key';
  }
  send.click();
  return 'clicked-send';
})()
"""


async def main():
    page = [t for t in targets() if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=64 * 1024 * 1024) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')

        await c.ev("""
        (() => { window.__errs = [];
          window.addEventListener('error', e => window.__errs.push(String(e.message).slice(0, 160)));
          window.addEventListener('unhandledrejection', e =>
            window.__errs.push('rej: ' + String(e.reason).slice(0, 160)));
          return true; })()
        """)

        print('typed :', await c.ev(SEND % json.dumps(PROMPT, ensure_ascii=False)))
        await asyncio.sleep(1)
        print('submit:', await c.ev(SUBMIT))

        saw = None
        for i in range(40):
            await asyncio.sleep(4)
            state = await c.ev("""
            (() => {
              const t = document.body.innerText;
              return JSON.stringify({
                tools: (t.match(/video_[a-z_]+/g) || []).slice(0, 6),
                streaming: /停止|生成中|思考中/.test(t),
                failed: /失败|错误|unavailable|超时/.test(t),
                tail: t.replace(/\\s+/g, ' ').slice(-260),
              });
            })()
            """)
            data = json.loads(state)
            if data['tools'] and saw != data['tools']:
                saw = data['tools']
                print('  tool call seen:', data['tools'])
            if not data['streaming'] and (data['tools'] or data['failed']):
                print()
                print('final tail:', data['tail'])
                print('failed flag:', data['failed'])
                break
        else:
            print('  (still running after 160s)')

        print('page errors:', await c.ev('JSON.stringify(window.__errs)'))
        return 0


sys.exit(asyncio.run(main()))
