import json
import asyncio
import websockets

async def send_and_wait(ws, method, params=None, timeout=10):
    params = params or {}
    req_id = send_and_wait.counter
    send_and_wait.counter += 1
    await ws.send(json.dumps({'id': req_id, 'method': method, 'params': params}))
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(f'{method} timeout')
        msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
        data = json.loads(msg)
        if data.get('id') == req_id:
            return data

send_and_wait.counter = 1

async def eval_expr(ws, expr, return_by_value=True):
    resp = await send_and_wait(ws, 'Runtime.evaluate', {
        'expression': expr,
        'returnByValue': return_by_value,
        'awaitPromise': True,
    })
    result = resp.get('result', {}).get('result', {})
    if result.get('type') == 'string' and result.get('value'):
        return result['value']
    return result.get('value')

async def main():
    uri = 'ws://localhost:9333/devtools/page/11D43FCF2EE074FB9C23CBC95BEA8ED3'
    async with websockets.connect(uri) as ws:
        await send_and_wait(ws, 'Runtime.enable')
        await asyncio.sleep(1)

        # Cancel current syncs
        await eval_expr(ws, """
        (() => {
            const running = store.syncs.filter(s => s.status === 'running');
            running.forEach(s => store.cancelSync(s.id));
            return 'cancelled ' + running.length;
        })()
        """)
        await asyncio.sleep(1)

        # Trigger favorites sync
        print('startSync:', await eval_expr(ws, """
        (async () => {
            try {
                const id = store.startSync('favorites');
                return JSON.stringify({success: true, id});
            } catch (e) {
                return JSON.stringify({success: false, error: e.message});
            }
        })()
        """))

        # Poll for 60 seconds
        for i in range(30):
            await asyncio.sleep(2)
            state = await eval_expr(ws, "JSON.stringify({syncs: store.syncs.map(s => ({id: s.id, kind: s.kind, status: s.status, step: s.step, added: s.added, total: s.total})), favCache: store.syncCache.favorites ? {collections_count: store.syncCache.favorites.collections.length, items_count: store.syncCache.favorites.items.length} : null})")
            print(f't={i*2+2}s:', state[:700])

asyncio.run(main())
