import sqlite3
conn = sqlite3.connect('D:/dydown/dy_downloader.db')
cur = conn.cursor()
# 查看表结构
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print("tables:", [r[0] for r in cur.fetchall()])
# 搜索茄子
cur.execute("SELECT sec_uid, nickname, aweme_count FROM following WHERE nickname LIKE ? LIMIT 5", ("%茄子%",))
print("matches:", cur.fetchall())
# 随便取几个有作品的
cur.execute("SELECT sec_uid, nickname, aweme_count FROM following WHERE aweme_count > 0 LIMIT 5")
print("sample:", cur.fetchall())
conn.close()
