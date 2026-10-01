"""Submit a prompt and record every tool call, to measure looping.

Looping is the failure this measures: the model calling the same tool over and
over with only the query word changed. So the report counts calls per tool and
lists the distinct queries, rather than just saying whether the turn finished.
"""
import asyncio
import json
import sys
import time
import urllib.request

import websockets

TOKEN = sys.argv[1]
PROMPT = sys.argv[2]
LIMIT_SECONDS = int(sys.argv[3]) if len(sys.argv) > 3 else 420
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


SEND = """
(() => { const b = document.querySelector('[contenteditable="true"]');
  if (!b) return 'no-composer'; b.focus();
  document.execCommand('insertText', false, %s); return 'typed'; })()
"""

SUBMIT = """
(() => { const norm = s => (s||'').replace(/\\s+/g,' ').trim();
  const s = [...document.querySelectorAll('button,[role="button"]')]
    .filter(x => x.offsetParent !== null)
    .find(x => /发送|Send/i.test(norm(x.getAttribute('aria-label')) || norm(x.title)));
  if (s) { s.click(); return 'clicked'; }
  const b = document.querySelector('[contenteditable="true"]');
  b.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  return 'enter'; })()
"""

# Reads the transcript text the UI already rendered. Counting tool names and the
# queries passed to them is what distinguishes "worked" from "looped".
SURVEY = """
(() => {
  const t = document.body.innerText;
  const names = t.match(/video_[a-z_]+/g) || [];
  const counts = {};
  for (const n of names) counts[n] = (counts[n] || 0) + 1;
  const queries = [...t.matchAll(/["“]?(?:query|检索关键词)["”]?\\s*[:：]\\s*["“]([^"”]{1,24})["”]/g)]
    .map(m => m[1]);
  return JSON.stringify({
    toolCounts: counts,
    totalCalls: names.length,
    distinctQueries: [...new Set(queries)],
    streaming: /停止|生成中|思考中/.test(t),
    steps: (t.match(/(\\d+)\\s*步/) || [null, null])[1],
    tail: t.replace(/\\s+/g,' ').slice(-200),
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

        # A fresh conversation, so the measurement is of this prompt alone.
        await c.ev("""
        (() => { const norm = s => (s||'').replace(/\\s+/g,' ').trim();
          const b = [...document.querySelectorAll('button,[role="button"]')]
            .find(x => norm(x.innerText).startsWith('新会话'));
          if (b) b.click(); return Boolean(b); })()
        """)
        await asyncio.sleep(6)

        print('prompt:', PROMPT)
        print('typed :', await c.ev(SEND % json.dumps(PROMPT, ensure_ascii=False)))
        await asyncio.sleep(1)
        print('submit:', await c.ev(SUBMIT))

        started = time.time()
        last = None
        while time.time() - started < LIMIT_SECONDS:
            await asyncio.sleep(6)
            data = json.loads(await c.ev(SURVEY))
            if data['toolCounts'] != last:
                last = data['toolCounts']
                print('  %4.0fs  calls=%d  %s' % (
                    time.time() - started, data['totalCalls'],
                    ', '.join('%s×%d' % (k, v) for k, v in sorted(data['toolCounts'].items()))))
            if not data['streaming'] and data['totalCalls'] > 0:
                break

        data = json.loads(await c.ev(SURVEY))
        print()
        print('=== 结果 ===')
        print('总工具调用:', data['totalCalls'])
        print('按工具   :', json.dumps(data['toolCounts'], ensure_ascii=False))
        print('不同检索词:', json.dumps(data['distinctQueries'], ensure_ascii=False))
        print('步数     :', data['steps'])
        print('结尾     :', data['tail'][-260:])
        return 0


sys.exit(asyncio.run(main()))
