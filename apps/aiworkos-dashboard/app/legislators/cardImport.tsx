"use client";

import { useRef, useState } from "react";
import { ORG_CATEGORIES } from "@/lib/categories";

// 名刺の写メから人脈DBへ入れるタブ。/legislators の3つ目のタブとして出る。
//
// 設計の前提は「読み取った内容をそのまま書かない」。
//   人脈DBは議事・週報・提案の突合先なので、誤読が1件入るとその人物にぶら下がる
//   記録が全部ずれる。だから読み取り(POST)と登録(PUT)を分け、間に必ず
//   1件ずつ直せる確認フォームを挟む。/health の写メ取り込みと同じ作法。
//
// 「登録する人だけチェック」方式にしている理由:
//   Eightの一覧を撮ると、既に人脈DBに居る人も一緒に写る。全部入れると重複行が増える。
//   同じ団体に同じ氏名が既に居る行は、チェックできないようにしてある。
//
// 文字サイズは px 直指定を使わない（globals.css で root font-size を画面幅に応じて
// 上げているため、rem / Tailwind のクラスで書く）。

const MAX_EDGE = 1568; // これ以上大きくしてもモデルの読み取り精度は上がらない
const JPEG_QUALITY = 0.85;
const MAX_IMAGES = 6;

type OrgOption = { name: string; category: string | null };

type Duplicate = {
  name: string;
  org_name: string | null;
  department: string | null;
  title: string | null;
  eight_registered_on: string | null;
  sameOrg: boolean;
};

type Card = {
  id: string;
  name: string;
  company: string;
  deptTitle: string;
  department: string | null;
  title: string | null;
  tel: string;
  email: string;
  exchanged: string | null;
  raw: string;
  orgMatch: { name: string; category: string | null } | null;
  duplicate: Duplicate | null;
  warnings: string[];
};

/** 画面で編集する状態。読み取り結果を種にして、ここから先は人が直す。 */
type Draft = {
  name: string;
  orgName: string;
  orgCategory: string;
  department: string;
  title: string;
  exchanged: string;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("画像を読み込めませんでした"));
    r.readAsDataURL(file);
  });
}

// canvas に描き直すので iPhone の HEIC も JPEG になる。
// 原寸のまま送ると Vercel のリクエスト上限(4.5MB)に当たるため、縮小は必須。
async function downscaleToJpeg(file: File): Promise<string> {
  const original = await fileToDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("画像を読み込めませんでした"));
    el.src = original;
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasが使えませんでした");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

const FIELD =
  "min-h-[2.75rem] w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900";

export function CardImport({ onSaved }: { onSaved: () => void }) {
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [today, setToday] = useState<string>("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const orgNames = new Set(orgs.map((o) => o.name));

  function reset() {
    setCards([]);
    setDrafts({});
    setPicked(new Set());
    setNotes([]);
    setError(null);
    setSavedMsg(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (files.length > MAX_IMAGES) {
      setError(`一度に読めるのは${MAX_IMAGES}枚までです`);
      return;
    }
    setBusy("reading");
    setError(null);
    setSavedMsg(null);
    try {
      const images = await Promise.all(Array.from(files).map(downscaleToJpeg));
      const res = await fetch("/api/legislators/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "読み取りに失敗しました");

      const got: Card[] = json.cards ?? [];
      setCards(got);
      setOrgs(json.orgs ?? []);
      setNotes(json.notes ?? []);
      setToday(json.today ?? "");
      setDrafts(
        Object.fromEntries(
          got.map((c) => [
            c.id,
            {
              name: c.name,
              // 顧客CRMに同じ団体があればその正式名称に寄せる（表記ゆれで重複を作らないため）。
              orgName: c.orgMatch?.name ?? c.company,
              orgCategory: "",
              department: c.department ?? "",
              title: c.title ?? "",
              exchanged: c.exchanged ?? json.today ?? "",
            } satisfies Draft,
          ])
        )
      );
      // 既に同じ団体に同じ氏名が居る人は、既定でチェックを外す（重複行を作らない）。
      setPicked(new Set(got.filter((c) => !c.duplicate?.sameOrg).map((c) => c.id)));
      if (got.length === 0) {
        setError("名刺を読み取れませんでした。名刺かEightの一覧が写った画面を送ってください。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み取りに失敗しました");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function edit(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function save() {
    const targets = cards.filter((c) => picked.has(c.id));
    if (targets.length === 0) return;
    const rows = targets.map((c) => {
      const d = drafts[c.id];
      return {
        name: d.name,
        orgName: d.orgName,
        orgCategory: d.orgCategory,
        department: d.department,
        title: d.title,
        exchanged: d.exchanged,
        tel: c.tel,
        email: c.email,
        raw: c.raw || c.deptTitle,
      };
    });
    const missing = rows.find((r) => !r.name.trim() || !r.orgName.trim());
    if (missing) {
      setError("氏名と団体が空の行があります");
      return;
    }
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch("/api/legislators/cards", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, today }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "登録に失敗しました");
      const failed: { name: string; reason: string }[] = json.failed ?? [];
      // reset() は savedMsg も消すので、先に片付けてからメッセージを出す。
      reset();
      const parts = [`${json.created.length}名を人脈DBへ登録しました`];
      if (json.createdOrgs?.length) parts.push(`団体「${json.createdOrgs.join("・")}」も作成`);
      if (failed.length) parts.push(`登録できず: ${failed.map((f) => f.name).join("・")}`);
      setSavedMsg(parts.join("／"));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  const pickedCount = cards.filter((c) => picked.has(c.id)).length;

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-base font-bold text-gray-900">📷 名刺を写メで追加</h2>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          名刺そのものでも、Eightの連絡先一覧のスクショでも読み取れます。
          読み取った内容は登録前に必ず直せます。写真は保存しません。
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id="card-photo-input"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label
            htmlFor="card-photo-input"
            className={`inline-flex min-h-[2.75rem] cursor-pointer items-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition active:scale-95 ${
              busy ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {busy === "reading" ? "読み取り中…" : "写真を選ぶ"}
          </label>
          <span className="text-xs text-gray-400">一度に{MAX_IMAGES}枚まで</span>
          {(cards.length > 0 || error) && (
            <button
              type="button"
              onClick={reset}
              className="ml-auto text-sm text-gray-500 active:opacity-70"
            >
              やり直す
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        )}
        {savedMsg && (
          <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {savedMsg}
          </p>
        )}
        {notes.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {notes.map((n, i) => (
              <li key={i}>・{n}</li>
            ))}
          </ul>
        )}
      </div>

      {cards.map((c) => {
        const d = drafts[c.id];
        if (!d) return null;
        const blocked = c.duplicate?.sameOrg === true;
        const newOrg = d.orgName.trim() !== "" && !orgNames.has(d.orgName.trim());
        return (
          <div
            key={c.id}
            className={`rounded-2xl border p-4 ${
              picked.has(c.id) ? "border-indigo-300 bg-indigo-50/40" : "border-gray-200 bg-white"
            }`}
          >
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={picked.has(c.id)}
                disabled={blocked}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    return next;
                  })
                }
                className="mt-1 h-5 w-5 shrink-0 accent-indigo-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-900">{c.name}</span>
                <span className="mt-0.5 block break-words text-xs text-gray-500">
                  {c.company || "（会社名の記載なし）"}
                  {c.deptTitle ? ` ／ ${c.deptTitle}` : ""}
                </span>
              </span>
            </label>

            {/* 既に人脈DBに居る可能性。同一人物かどうかはここでは決めない。 */}
            {c.duplicate && (
              <p
                className={`mt-3 rounded-xl px-3 py-2 text-xs ${
                  blocked ? "bg-gray-100 text-gray-600" : "bg-amber-50 text-amber-800"
                }`}
              >
                {blocked ? "登録済み：" : "同じ氏名の行があります："}
                {c.duplicate.name}（{c.duplicate.org_name ?? "団体なし"}／
                {c.duplicate.title ?? c.duplicate.department ?? "役職なし"}
                {c.duplicate.eight_registered_on ? `／${c.duplicate.eight_registered_on}` : ""}）
                {blocked
                  ? " 既存の行は上書きしません。役職が変わっていたらNotionで直してください。"
                  : " 別人なら、そのまま登録してかまいません。"}
              </p>
            )}

            {c.warnings
              .filter((w) => !w.startsWith("人脈DBに同じ氏名"))
              .map((w, i) => (
                <p key={i} className="mt-2 text-xs text-amber-700">
                  ⚠ {w}
                </p>
              ))}

            <div className="mt-3 space-y-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">氏名</span>
                <input
                  value={d.name}
                  onChange={(e) => edit(c.id, { name: e.target.value })}
                  className={FIELD}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">
                  団体（顧客CRM）
                </span>
                <input
                  list="card-org-list"
                  value={d.orgName}
                  placeholder="例：公明党"
                  onChange={(e) => edit(c.id, { orgName: e.target.value })}
                  className={FIELD}
                />
              </label>

              {/* 未登録の団体は種別を選ばせる。選ばずに登録すると、人物の
                  リレーション先が作れないのでサーバー側で弾かれる。 */}
              {newOrg && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-amber-700">
                    「{d.orgName}」は顧客CRMに未登録です。種別を選ぶと新しく作ります
                  </span>
                  <select
                    value={d.orgCategory}
                    onChange={(e) => edit(c.id, { orgCategory: e.target.value })}
                    className={FIELD}
                  >
                    <option value="">種別を選ぶ</option>
                    {ORG_CATEGORIES.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600">部署</span>
                  <input
                    value={d.department}
                    onChange={(e) => edit(c.id, { department: e.target.value })}
                    className={FIELD}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600">役職</span>
                  <input
                    value={d.title}
                    onChange={(e) => edit(c.id, { title: e.target.value })}
                    className={FIELD}
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">交換日</span>
                <input
                  type="date"
                  value={d.exchanged}
                  max={today || undefined}
                  onChange={(e) => edit(c.id, { exchanged: e.target.value })}
                  className={FIELD}
                />
              </label>

              {(c.tel || c.email) && (
                <p className="text-xs text-gray-500">
                  メモに残る連絡先：{[c.tel, c.email].filter(Boolean).join(" ／ ")}
                </p>
              )}
            </div>
          </div>
        );
      })}

      <datalist id="card-org-list">
        {orgs.map((o) => (
          <option key={o.name} value={o.name}>
            {o.category ?? ""}
          </option>
        ))}
      </datalist>

      {cards.length > 0 && (
        <div className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] rounded-2xl border border-gray-300 bg-white/95 p-3 backdrop-blur">
          <button
            type="button"
            onClick={save}
            disabled={pickedCount === 0 || busy !== null}
            className="min-h-[2.75rem] w-full rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-40"
          >
            {busy === "saving" ? "登録中…" : `${pickedCount}名を人脈DBへ登録する`}
          </button>
          <p className="mt-2 text-center text-xs text-gray-500">
            Notionの人脈DBへ作り、この画面にもすぐ出ます
          </p>
        </div>
      )}
    </section>
  );
}
