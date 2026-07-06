import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.compat import ensure_backend_path
ensure_backend_path()

from storage.database import Database  # noqa: E402

async def main():
    db_path = r'd:\DOU\douzy-electron\python\test_report.db'
    if os.path.exists(db_path):
        os.remove(db_path)

    db = Database(db_path=db_path)
    await db.initialize()

    now = int(time.time())
    for i in range(5):
        aweme_id = f'aweme_{i}'
        await db.add_aweme({
            'aweme_id': aweme_id,
            'aweme_type': 'video',
            'title': f'视频 {i}',
            'author_name': '测试作者',
            'author_id': 'author_1',
            'file_path': f'd:/test/{aweme_id}.mp4',
        })
        await db.record_download_history(
            aweme_id=aweme_id,
            mode='single',
            status='success',
            file_path=f'd:/test/{aweme_id}.mp4',
        )

    await db.close()
    print('created', db_path)

asyncio.run(main())
