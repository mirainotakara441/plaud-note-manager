import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieValueFor } from "@/lib/auth";
import { HOJIN_QA_COOKIE_NAME, hojinQaPassphrase } from "@/lib/hojinQaAuth";
import data from "@/lib/hojinQa/data.json";
import type { HojinQaData } from "@/lib/hojinQa/types";
import HojinQaClient from "./HojinQaClient";

// 法人請求 営業実戦QA検索の実体。
//
// 商談中にスマホで「相手が言った直後に該当の1件を出す」道具。データは
// lib/hojinQa/data.json（Desktop の QA表_確定版 Markdown から
// scripts/build-hojin-qa.mjs で生成。中身を直したら作り直してコミット）。
//
// 守りは proxy.ts が QA専用 cookie（hojin_qa_auth）で行う。ここでも同じ判定を
// 二重にかけているのは、proxy の matcher 設定ミスや将来の経路追加で素通りに
// ならないための保険（lib/hojinQaAuth.ts）。

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "法人請求QA検索",
};

export default async function HojinQaPage() {
  const passphrase = hojinQaPassphrase();
  if (!passphrase) redirect("/qa-gate");
  const store = await cookies();
  const value = store.get(HOJIN_QA_COOKIE_NAME)?.value;
  if (!value || value !== (await cookieValueFor(passphrase))) {
    redirect("/qa-gate");
  }
  return <HojinQaClient data={data as HojinQaData} />;
}
