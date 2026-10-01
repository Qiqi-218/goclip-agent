"""Submit a prompt and wait for the turn to actually finish.

Waits on the presence of the stop control, which the composer shows only while a
turn is running. An earlier version inferred completion from "no tool calls in the
first poll", which reported a finished turn while the interface still said
"preparing to call".
"""
import asyncio
import json
import sys
import time
import urllib.request

import websockets

TOKEN = sys.argv[1]
PROMPT = sys.argv[2]
LIMIT = int(sys.argv[3]) if len(sys.argv) > 3 else 600
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


SURVEY = """
(() => {
  const t = document.body.innerText;
  const names = t.match(/video_[a-z_]+/g) || [];
  const counts = {};
  for (const n of names) counts[n] = (counts[n] || 0) + 1;
  const queries = [...t.matchAll(/["“]([^"”]{1,22})["”]/g)].map(m => m[1]);
  // The composer shows a stop control only while a turn runs.
  const running = [...document.querySelectorAll('button,[role="button"]')]
    .some(b => b.offsetParent !== null && /^(停止|Stop)/.test((b.innerText||'').trim()));
  return JSON.stringify({
    toolCounts: counts,
    totalCalls: names.length,
    quoted: [...new Set(queries)],
    running,
    tail: t.replace(/\\s+/g,' ').slice(-240),
  });
})()
"""


async def main():
    page = [t for t in targets() if t.get('type') == 'page'][0]
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=2 ** 26) as ws:
        c = Cdp(ws)
        await c.send('Runtime.enable')
        await c.send('Page.enable')
        await c.send('Page.reload')
        await asyncio.sleep(17)
        await c.ev("""
        (() => { const norm = s => (s||'').replace(/\\s+/g,' ').trim();
          const b = [...document.querySelectorAll('button,[role="button"]')]
            .find(x => norm(x.innerText).startsWith('新会话'));
          if (b) b.click(); return Boolean(b); })()
        """)
        await asyncio.sleep(6)

        print('prompt:', PROMPT)
        await c.ev("""
        (() => { const b = document.querySelector('[contenteditable="true"]');
          b.focus(); document.execCommand('insertText', false, %s); return 'typed'; })()
        """ % json.dumps(PROMPT, ensure_ascii=False))
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

        started = time.time()
        last = None
        saw_running = False
        while time.time() - started < LIMIT:
            await asyncio.sleep(6)
            d = json.loads(await c.ev(SURVEY))
            if d['running']:
                saw_running = True
            if d['toolCounts'] != last:
                last = d['toolCounts']
                print('  %4.0fs  running=%s calls=%d  %s' % (
                    time.time() - started, d['running'], d['totalCalls'],
                    ', '.join('%s×%d' % (k, v) for k, v in sorted(d['toolCounts'].items()))))
            if saw_running and not d['running']:
                print('  %4.0fs  回合结束' % (time.time() - started))
                break

        d = json.loads(await c.ev(SURVEY))
        print()
        print('=== 结果 ===')
        print('是否见过运行态:', saw_running, '（False 说明可能是判据没抓到）')
        print('总调用:', d['totalCalls'], json.dumps(d['toolCounts'], ensure_ascii=False))
        print('文中引号内容:', json.dumps(d['quoted'][:14], ensure_ascii=False))
        print('结尾:', d['tail'][-300:])
        return 0


sys.exit(asyncio.run(main()))
