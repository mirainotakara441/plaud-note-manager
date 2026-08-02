#!/usr/bin/env bash
# X（@0kara1_man）の開発者キーを .env.local に書き込む。
#
# 使い方: Xのキー画面（またはメモに控えた4本）を「ラベルごと丸ごと」コピーして Enter。
# ラベル行の次の行を値として拾うので、1回のコピーで4本まとめて入る。
# 値は画面に表示しない。シェルの履歴にも残らない。
#
# 想定している貼り付け元の形（日本語表示・英語表示のどちらでも可）:
#   コンシューマーキー
#   xxxxxxxx
#   コンシューマーキーシークレット
#   xxxxxxxx
#   アクセストークン
#   xxxxxxxx
#   アクセストークンシークレット
#   xxxxxxxx
set -uo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env.local"
[ -f "$ENV_FILE" ] || { echo "エラー: $ENV_FILE が見つかりません" >&2; exit 1; }

BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$BACKUP"

set_env() { # name value
  if grep -q "^${1}=" "$ENV_FILE"; then
    awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' \
      "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

echo "─────────────────────────────────────────────"
echo " Xの開発者キーを .env.local に書き込みます"
echo " 4本ぶんをラベルごと丸ごとコピーして Enter を押してください。"
echo " 値は画面に表示されません。"
echo "─────────────────────────────────────────────"
printf 'コピーしたら Enter > '
read -r _dummy

CLIP="$(pbpaste)"
[ -n "$CLIP" ] || { echo "クリップボードが空です。コピーしてからもう一度実行してください。"; exit 1; }

# ラベル行の「次の空でない行」を値として拾う。
# シークレット側を先に判定しないと、前方一致で取り違える。
extract() { # 検索パターン
  printf '%s' "$CLIP" | awk -v pat="$1" '
    matched && NF { gsub(/^[ \t]+|[ \t\r]+$/, "", $0); print; exit }
    $0 ~ pat { matched = 1 }
  '
}

API_KEY="$(extract '^[[:space:]]*(コンシューマーキー|API Key|APIキー)[[:space:]]*$')"
API_SECRET="$(extract '(コンシューマーキーシークレット|API Key Secret|APIキーシークレット)')"
ACCESS_TOKEN="$(extract '^[[:space:]]*(アクセストークン|Access Token)[[:space:]]*$')"
ACCESS_SECRET="$(extract '(アクセストークンシークレット|Access Token Secret)')"

ok=1
check() { # ラベル 値 下限 上限
  local len=${#2}
  if [ "$len" -eq 0 ]; then
    echo "  ✗ $1 が見つかりませんでした"; ok=0; return
  fi
  if [ "$len" -lt "$3" ] || [ "$len" -gt "$4" ]; then
    echo "  ⚠ $1 は ${len}文字（想定 $3〜$4文字）。取り違えの可能性があります"; ok=0; return
  fi
  echo "  ✓ $1 （${len}文字）"
}

echo
echo "読み取り結果:"
check "API Key"             "$API_KEY"       20 30
check "API Key Secret"      "$API_SECRET"    45 60
check "Access Token"        "$ACCESS_TOKEN"  45 60
check "Access Token Secret" "$ACCESS_SECRET" 40 50

if [ "$ok" -ne 1 ]; then
  echo
  printf 'このまま書き込みますか？ [y/N] > '
  read -r ans
  [ "$ans" = "y" ] || { echo "中止しました。$ENV_FILE は変更していません。"; rm -f "$BACKUP"; exit 1; }
fi

set_env X_API_KEY             "$API_KEY"
set_env X_API_SECRET          "$API_SECRET"
set_env X_ACCESS_TOKEN        "$ACCESS_TOKEN"
set_env X_ACCESS_TOKEN_SECRET "$ACCESS_SECRET"

# iPhoneショートカット用の合言葉。Xとは無関係なので、未設定なら自動生成する。
CUR="$(grep '^RAMEN_CAPTURE_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$CUR" ]; then
  set_env RAMEN_CAPTURE_SECRET "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
  echo "  ✓ RAMEN_CAPTURE_SECRET を自動生成しました（48文字）"
fi

echo
echo "書き込み完了。控え: $BACKUP"
for k in X_API_KEY X_API_SECRET X_ACCESS_TOKEN X_ACCESS_TOKEN_SECRET RAMEN_CAPTURE_SECRET; do
  v="$(grep "^${k}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
  printf '  %-24s %s文字\n' "$k" "${#v}"
done
echo
echo "※ クリップボードに秘密が残っています。何か別のものをコピーして上書きしてください。"
