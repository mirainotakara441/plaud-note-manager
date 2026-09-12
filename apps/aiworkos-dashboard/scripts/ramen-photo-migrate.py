#!/usr/bin/env python3
"""iPhoneの写真アルバムから書き出したラーメン写真を、ramen_logs へ一括で紐付ける。

写真のメモ欄（macOSの kMDItemDescription）が一次情報。杯番号・★・店名・
メニュー・価格が手書きで入っているので、そこから杯番号を拾って行を特定し、
写真を Supabase Storage（非公開バケット ramen-photos）へ置いて
photo_urls に足す。★が空の行には stars / stars_label も入れる。

食べログ由来の列（shop・eaten_on・bowl_no・score）は触らない。
杯番号は食べログから推測すると必ずずれるため、ここで動かすと突合が崩れる。

使い方:
    # ① 下見（既定・書き込みなし）。メモ欄の読み取り結果を必ず目で確認する
    python3 scripts/ramen-photo-migrate.py --dir ~/Desktop/ラーメン写真

    # ② 1ヶ月だけ試す
    python3 scripts/ramen-photo-migrate.py --dir ~/Desktop/ラーメン写真 --month 2026-07 --apply

    # ③ 全量
    python3 scripts/ramen-photo-migrate.py --dir ~/Desktop/ラーメン写真 --apply

同じフォルダを二度流しても同じ写真が二重に入らないよう、上げ終わったファイルは
フォルダ内の .ramen-migrated.json に記録して次回から飛ばす。
"""

import argparse
import datetime
import json
import os
import random
import re
import string
import subprocess
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
STATE_FILE = ".ramen-migrated.json"
MAX_EDGE = 2048
MAX_PHOTOS_PER_LOG = 12
BUCKET = "ramen-photos"


# ---------------------------------------------------------------- 認証情報

def load_env(env_path):
    """.env.local から必要な2つだけ読む。値は絶対に表示しない。"""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if url and key:
        return url.rstrip("/"), key

    if not env_path.exists():
        sys.exit(f"環境変数も {env_path} も無いため接続先が分かりません")

    found = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        found[k.strip()] = v.strip().strip('"').strip("'")

    url = url or found.get("SUPABASE_URL")
    key = key or found.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(f"{env_path} に SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が揃っていません")
    return url.rstrip("/"), key


# ---------------------------------------------------------------- 写真のメモ欄

def mdls_value(path, attr):
    """Spotlightメタデータを1つ読む。無ければ None。"""
    try:
        out = subprocess.run(
            ["mdls", "-raw", "-name", attr, str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return None
    if out in ("", "(null)"):
        return None
    return out


# 半分を表す記号は ☆ が基本だが、写真によって ✩ や ⭐︎ も使われている
# （異体字セレクタ付きで入ることもあるので一緒に拾う）。
HALF_STARS = "☆✩⭐"
STAR_RE = re.compile(r"[★☆✩⭐][★☆✩⭐︎️]*")
BOWL_RE = re.compile(r"(\d{1,4})\s*杯目")
PRICE_RE = re.compile(r"([0-9][0-9,]*)\s*円")
# 書き出し時のファイル名に日付が入る形（IMG_20260711_… / 2026-07-11 …）への保険
NAME_DATE_RE = re.compile(r"(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})")


def parse_stars(text):
    """★★★☆ → 3.5。★が1、末尾の半分記号が0.5（2026-08の月次作業で確定した読み方）。

    返すのは (数値, 原文)。半分記号が2つ以上並ぶもの（★★★☆☆ など）は、
    「3.5＋0.5」なのか「5つ枠のうち3つ」なのか本人にしか分からないので、
    数値を None にして原文だけ返す（＝要確認。勝手に決めて入れない）。
    """
    m = STAR_RE.search(text or "")
    if not m:
        return None, None
    # 異体字セレクタは見た目に出ないので落としてから数える
    label = "".join(ch for ch in m.group(0) if ch not in "︎️")
    full = label.count("★")
    half = sum(label.count(h) for h in HALF_STARS)
    if full == 0:
        return None, None
    if half >= 2:
        return None, label
    value = full + (0.5 if half == 1 else 0.0)
    if value <= 0 or value > 5:
        return None, label
    return value, label


# 【96杯目】麺処夏海@赤羽 / 【30杯目②】　麺家たいせい@中野坂上 のように、
# 杯番号の直後に店名が来る。@以降（エリア）と、次の行のメニューは店名ではない。
SHOP_RE = re.compile(r"】\s*([^@\n・]+)")


def normalize_shop(s):
    """店名の突合用。空白・記号・表記ゆれを落として比べる。

    mdls が返す文字列は NFD（「ば」が「は」＋濁点に分解された形）で、DBの値は NFC。
    見た目が同じでも中身が違うので、先に NFC へ揃える。これを入れないと
    「中華そば半ざわ」同士が一致せず、店名での突合が全部すり抜ける。
    """
    if not s:
        return ""
    out = unicodedata.normalize("NFC", s)
    out = re.sub(r"[\s　]", "", out)
    return re.sub(r"[!-/:-@\[-`{-~！-／：-＠［-｀｛-～、。・「」『』…〜]", "", out)


def parse_memo(text):
    bowl = None
    m = BOWL_RE.search(text or "")
    if m:
        bowl = int(m.group(1))
    stars, stars_label = parse_stars(text)
    price = None
    mp = PRICE_RE.search(text or "")
    if mp:
        price = int(mp.group(1).replace(",", ""))
    shop = None
    ms = SHOP_RE.search(text or "")
    if ms:
        shop = ms.group(1).strip() or None
    return {
        "bowl_no": bowl,
        "stars": stars,
        "stars_label": stars_label,
        "price": price,
        "shop": shop,
    }


def shop_matches(memo_shop, row_shop):
    """どちらかがどちらかを含めば同じ店とみなす。

    メモは「ニューともちんラーメン」、DBは「新橋ニューともちんラーメン 西池袋店」の
    ように片方が長い。前方一致では拾えないので包含で見る。
    """
    a, b = normalize_shop(memo_shop), normalize_shop(row_shop)
    if len(a) < 3 or len(b) < 3:
        return False
    return a in b or b in a


def shot_date(path):
    """撮影日（JSTのYYYY-MM-DD）。杯番号が読めなかった時の突合に使う。

    mdls が返す日時は UTC（"2026-06-08 05:13:17 +0000"）。そのまま頭10桁を
    切ると、朝9時より前に撮った1杯が前日扱いになって突合が1日ずれる。
    """
    for attr in ("kMDItemContentCreationDate", "kMDItemFSCreationDate"):
        raw = mdls_value(path, attr)
        if not raw or len(raw) < 19 or raw[4] != "-":
            continue
        try:
            utc = datetime.datetime.strptime(raw[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        return (utc + datetime.timedelta(hours=9)).strftime("%Y-%m-%d")
    m = NAME_DATE_RE.search(path.name)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


# ---------------------------------------------------------------- Supabase

def rest_get(url, key, path_and_query):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path_and_query}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode())


def rest_patch(url, key, path_and_query, body):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path_and_query}",
        data=json.dumps(body).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode())


def storage_put(url, key, object_path, data):
    req = urllib.request.Request(
        f"{url}/storage/v1/object/{BUCKET}/{object_path}",
        data=data,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "image/jpeg",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as res:
        res.read()


def fetch_logs(url, key):
    cols = "id,eaten_on,bowl_no,shop,menu,stars,stars_label,score,photo_urls"
    rows = rest_get(url, key, f"ramen_logs?select={cols}&order=eaten_on.asc&limit=2000")
    by_bowl, by_date = {}, {}
    for r in rows:
        if r.get("bowl_no") is not None:
            # 杯番号は本来一意。重複していたら機械では決められないので候補として持つ
            by_bowl.setdefault(r["bowl_no"], []).append(r)
        by_date.setdefault(r["eaten_on"], []).append(r)
    return rows, by_bowl, by_date


# ---------------------------------------------------------------- 画像

def to_jpeg_bytes(path):
    """長辺2048のJPEGへ。sips を使うのでHEICもそのまま通る。"""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.jpg"
        proc = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85",
             "-Z", str(MAX_EDGE), str(path), "--out", str(out)],
            capture_output=True, text=True, timeout=180,
        )
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError(f"画像を変換できませんでした: {proc.stderr.strip()[:120]}")
        return out.read_bytes()


def object_path_for(log_id):
    stamp = "".join(random.choice(string.digits) for _ in range(14))
    rand = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    return f"{log_id}/{stamp}-{rand}.jpg"


# ---------------------------------------------------------------- 本体

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="書き出した写真が入っているフォルダ")
    ap.add_argument("--month", help="YYYY-MM。この月の写真だけを扱う")
    ap.add_argument("--apply", action="store_true", help="実際に書き込む（既定は下見のみ）")
    ap.add_argument("--limit", type=int, help="先頭N枚だけ扱う（試すとき用）")
    ap.add_argument(
        "--pin",
        action="append",
        default=[],
        metavar="ファイル名=id",
        help="機械で決められない1枚を手で指定する（例 --pin IMG_6251.JPG=54）。"
             "杯番号がずれている・店名の表記が違う分に使う",
    )
    ap.add_argument("--env", default=None, help=".env.local の場所")
    args = ap.parse_args()

    src = Path(os.path.expanduser(args.dir))
    if not src.is_dir():
        sys.exit(f"フォルダが見つかりません: {src}")

    env_path = Path(args.env) if args.env else Path(__file__).resolve().parent.parent / ".env.local"
    url, key = load_env(env_path)

    state_path = src / STATE_FILE
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    files = sorted(p for p in src.iterdir() if p.suffix.lower() in IMAGE_EXT)
    if not files:
        sys.exit(f"画像が1枚もありません: {src}")

    pins = {}
    for spec in args.pin:
        if "=" not in spec:
            sys.exit(f"--pin は ファイル名=id の形で書いてください: {spec}")
        name, raw_id = spec.rsplit("=", 1)
        if not raw_id.strip().isdigit():
            sys.exit(f"--pin のidが数字ではありません: {spec}")
        pins[name.strip()] = int(raw_id)

    print(f"読み取り中… {len(files)}枚（{src}）")
    rows, by_bowl, by_date = fetch_logs(url, key)
    by_id = {r["id"]: r for r in rows}
    print(f"ramen_logs {len(rows)}件を突合に使います\n")

    for name, pinned_id in pins.items():
        if pinned_id not in by_id:
            sys.exit(f"--pin で指定した id={pinned_id} の行がありません（{name}）")

    plans, skipped, unmatched = [], [], []

    for path in files:
        memo = mdls_value(path, "kMDItemDescription") or ""
        parsed = parse_memo(memo)
        date = shot_date(path)

        if args.month and not (date or "").startswith(args.month):
            continue

        if str(path.name) in state:
            skipped.append((path, "前回すでに上げた"))
            continue

        match, how = None, ""

        # ⓪ 手で指定された分。機械の推測より優先する
        if path.name in pins:
            match, how = by_id[pins[path.name]], "手で指定"

        # ① 杯番号で決める。一意なら一番強い手がかり
        bowl = parsed["bowl_no"]
        if match is None and bowl is not None:
            cands = by_bowl.get(bowl, [])
            if len(cands) == 1:
                match, how = cands[0], f"{bowl}杯目"
            elif len(cands) > 1:
                # 杯番号が重複している行がある（食べログからの推測でずれた分）。
                # メモの店名で絞れれば決められる
                named = [r for r in cands if shop_matches(parsed["shop"], r["shop"])]
                if len(named) == 1:
                    match, how = named[0], f"{bowl}杯目＋店名"
                else:
                    unmatched.append(
                        (path, memo, f"{bowl}杯目の行が{len(cands)}件あり店名でも絞れない")
                    )
                    continue

        # ② 杯番号で決まらなければ、撮影日の前後1日×店名で探す。
        #    杯番号そのものがずれている分（DBに欠番がある分）はここで拾える
        if match is None and date:
            near = []
            for delta in (0, -1, 1):
                d = (
                    datetime.datetime.strptime(date, "%Y-%m-%d")
                    + datetime.timedelta(days=delta)
                ).strftime("%Y-%m-%d")
                near.extend(by_date.get(d, []))
            named = [r for r in near if shop_matches(parsed["shop"], r["shop"])]
            if len(named) == 1:
                match, how = named[0], f"撮影日{date}±1日＋店名"
            elif len(named) > 1:
                unmatched.append((path, memo, f"{date}前後に同じ店の記録が{len(named)}件ある"))
                continue
            else:
                # ③ 最後の手段。その日に1杯しか無ければそれで確定できる
                same_day = by_date.get(date, [])
                if len(same_day) == 1:
                    match, how = same_day[0], f"撮影日 {date}"
                else:
                    why = (
                        f"{date} の記録が無い"
                        if not same_day
                        else f"{date} に{len(same_day)}杯あり店名も合わない"
                    )
                    unmatched.append((path, memo, why))
                    continue

        if match is None:
            unmatched.append((path, memo, "杯番号も撮影日も読めない"))
            continue

        current = match.get("photo_urls") or []
        if len(current) >= MAX_PHOTOS_PER_LOG:
            skipped.append((path, f"id={match['id']} はすでに{len(current)}枚"))
            continue

        plans.append({
            "file": path,
            "log": match,
            "how": how,
            "memo": memo,
            "stars": parsed["stars"],
            "stars_label": parsed["stars_label"],
        })
        if args.limit and len(plans) >= args.limit:
            break

    # ---- 下見の表示。メモ欄の読み取りが合っているかを、ここで必ず目で見る
    print(f"■ 紐付けできる: {len(plans)}枚")
    for p in plans[:200]:
        log = p["log"]
        star = ""
        if p["stars"] is not None:
            star = (
                f" {p['stars_label']}（{p['stars']}）→ 入れる"
                if log.get("stars") is None
                else f" {p['stars_label']}（既に{log['stars']}が入っているので触らない）"
            )
        elif p["stars_label"]:
            star = f" {p['stars_label']} ← ★の読み方が決められないので入れません（要確認）"
        print(f"  {p['file'].name}  →  id={log['id']} {log['eaten_on']} {log['shop']}"
              f"  [{p['how']}]{star}")
    if len(plans) > 200:
        print(f"  …ほか{len(plans) - 200}枚")

    if skipped:
        print(f"\n■ 飛ばす: {len(skipped)}枚")
        for path, why in skipped[:40]:
            print(f"  {path.name}  …  {why}")
        if len(skipped) > 40:
            print(f"  …ほか{len(skipped) - 40}枚")

    if unmatched:
        print(f"\n■ 紐付けできない: {len(unmatched)}枚（メモ欄の原文つき）")
        for path, memo, why in unmatched[:40]:
            head = (memo or "（メモ欄が空）").replace("\n", " / ")[:70]
            print(f"  {path.name}  …  {why}\n      メモ: {head}")
        if len(unmatched) > 40:
            print(f"  …ほか{len(unmatched) - 40}枚")

    if not args.apply:
        print("\n下見だけで終わりました。内容が合っていれば --apply を付けて実行してください。")
        return

    if not plans:
        print("\n上げるものがありません。")
        return

    # ---- 実行。1枚ずつ「上げる→行に足す」を閉じる。まとめて最後に書くと、
    #      途中で落ちたときにStorageに孤児の写真だけが残る。
    print(f"\n書き込みます（{len(plans)}枚）")
    done = 0
    for p in plans:
        log, path = p["log"], p["file"]
        try:
            data = to_jpeg_bytes(path)
            obj = object_path_for(log["id"])
            storage_put(url, key, obj, data)

            patch = {"photo_urls": (log.get("photo_urls") or []) + [obj]}
            # ★は空いている時だけ入れる。手で入れた値を上書きしない
            if p["stars"] is not None and log.get("stars") is None:
                patch["stars"] = p["stars"]
                patch["stars_label"] = p["stars_label"]

            saved = rest_patch(url, key, f"ramen_logs?id=eq.{log['id']}", patch)
            if not saved:
                raise RuntimeError("行の更新が空で返った")

            # 同じ行に続けて足す時のために、手元の控えも進める
            log["photo_urls"] = saved[0].get("photo_urls") or patch["photo_urls"]
            if "stars" in patch:
                log["stars"] = patch["stars"]

            state[str(path.name)] = {"id": log["id"], "path": obj}
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1))
            done += 1
            print(f"  ✓ {path.name} → id={log['id']} {log['shop']}（{len(log['photo_urls'])}枚目）")
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError, OSError) as e:
            detail = ""
            if isinstance(e, urllib.error.HTTPError):
                detail = e.read().decode(errors="replace")[:160]
            print(f"  × {path.name} …失敗: {e} {detail}")

    print(f"\n終わりました。{done}／{len(plans)}枚。控えは {state_path.name}")
    print("画面（/ramen）を開いて、写真と★が出ているか確認してください。")


if __name__ == "__main__":
    main()
