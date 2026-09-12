#!/usr/bin/env python3
"""移行した写真のうち、機械では決めきれなかった分を洗い出す。

ramen-photo-migrate.py が書いた .ramen-migrated.json（ファイル名→行id）と、
写真のメモ欄を突き合わせて、次の3つを報告する:

  ① ★の読み方が決められなかった分（半分の記号が2つ並んでいるもの）
  ② メモの杯番号と、DBの bowl_no が食い違っている分
  ③ メモに★があるのに、行の stars が空のままの分

読むだけで、何も書き換えない。
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mig", HERE / "ramen-photo-migrate.py")
mig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mig)


def main():
    src = Path(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/Desktop/ラーメン"))
    state_path = src / mig.STATE_FILE
    if not state_path.exists():
        sys.exit(f"移行の控えがありません: {state_path}")
    state = json.loads(state_path.read_text())

    url, key = mig.load_env(HERE.parent / ".env.local")
    rows = mig.rest_get(
        url, key,
        "ramen_logs?select=id,eaten_on,bowl_no,shop,stars,stars_label,score,photo_urls&limit=2000",
    )
    by_id = {r["id"]: r for r in rows}

    star_unclear, bowl_mismatch, stars_empty = [], [], []

    for name, rec in sorted(state.items()):
        log = by_id.get(rec["id"])
        if not log:
            continue
        memo = mig.mdls_value(src / name, "kMDItemDescription") or ""
        parsed = mig.parse_memo(memo)

        if parsed["stars"] is None and parsed["stars_label"]:
            star_unclear.append((name, log, parsed, memo))
        elif parsed["stars"] is not None and log.get("stars") is None:
            stars_empty.append((name, log, parsed))

        if parsed["bowl_no"] is not None and log.get("bowl_no") != parsed["bowl_no"]:
            bowl_mismatch.append((name, log, parsed))

    def head(log):
        return f"id={log['id']} {log['eaten_on']} {log['shop']}"

    print(f"■ ★の読み方が決められなかった: {len(star_unclear)}枚")
    for name, log, parsed, memo in star_unclear:
        print(f"  {name}  {head(log)}")
        print(f"    メモの★: {parsed['stars_label']}")
        print(f"    食べログの点数: {log.get('score') or '—'}")
        print(f"    メモ全文: {memo.strip()[:160]}")

    print(f"\n■ メモの杯番号とDBの杯番号が違う: {len(bowl_mismatch)}件")
    for name, log, parsed in bowl_mismatch:
        print(f"  {name}  {head(log)}  …  メモ「{parsed['bowl_no']}杯目」／DB「"
              f"{log.get('bowl_no') if log.get('bowl_no') is not None else '空'}杯目」")

    print(f"\n■ メモに★があるのに行が空のまま: {len(stars_empty)}件")
    for name, log, parsed in stars_empty:
        print(f"  {name}  {head(log)}  …  {parsed['stars_label']}（{parsed['stars']}）")


if __name__ == "__main__":
    main()
