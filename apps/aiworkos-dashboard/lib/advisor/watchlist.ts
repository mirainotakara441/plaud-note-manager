// 「何を、何日止まったら止まっているとみなすか」の一覧。
//
// ここが唯一の正。朝のPush通知（/api/cron/daily-todo）と、ホームの
// 「今朝の気づき」（/api/advisor）の両方がここを読む。閾値が2か所にあると、
// 片方だけ直して食い違い、どちらの言い分が正しいのか分からなくなる。
//
// 閾値はその仕組みの自然な間隔に合わせる。鳴りっぱなしになると通知そのものを
// 無視するようになり、本当に止まった時に気づけなくなる——それがいちばん怖い。

/** launchd で回している定期実行ジョブの心拍。 */
export const WATCHED_JOBS: Array<{ job: string; label: string; staleHours: number }> = [
  // Mac上のジョブはMacを閉じている間は打刻できない。週末に閉じっぱなしでも
  // 誤報しないよう毎日のジョブは48時間まで待つ（Macを開けば次の実行で消える）。
  { job: "nippo-aggregate", label: "日報録の自動集計", staleHours: 48 },
  { job: "notion-sync", label: "Notion→Supabaseの同期", staleHours: 48 },
  { job: "giji", label: "議事エージェント", staleHours: 48 },
  { job: "tanaoroshi", label: "日次営業インテリジェンス", staleHours: 48 },
  // 週次バックアップは1回飛ばしたら気づきたいので8日。
  { job: "aiworkos-backup", label: "週次バックアップ", staleHours: 24 * 8 },
  { job: "ramen-x-followers", label: "ラーメンXのフォロワー記録", staleHours: 48 },
];

/**
 * Claudeのスケジュールタスク側。job_heartbeats を打てないので、
 * 各タスクが自分で更新する service_health を見る。
 *
 * notify: 朝のPush通知に含めるか。
 *   eight（人脈DBの取込）は月1回の手動運用なので、毎朝鳴らすと邪魔になる。
 *   ただし「6日半止まっている」ことに自分では気づけないため、
 *   ホームのカードには7日で出す（2026-08-03 吉井さんと相談して決めた）。
 */
export const WATCHED_SERVICES: Array<{
  service: string;
  label: string;
  staleDays: number;
  notify: boolean;
}> = [
  { service: "plaud", label: "PLAUD会議の自動登録", staleDays: 3, notify: true },
  { service: "news", label: "ニュース取得", staleDays: 3, notify: true },
  { service: "notion", label: "Notionの記憶同期", staleDays: 3, notify: true },
  { service: "eight", label: "Eightの取込", staleDays: 7, notify: false },
];

/** 一行日記が何日ぶん入っていなければ滞りとみなすか。 */
export const DIARY_STALE_THRESHOLD_DAYS = 3;

/** 健康データが何日ぶん入っていなければ滞りとみなすか。 */
export const HEALTH_STALE_THRESHOLD_DAYS = 3;
