# Billing / Entitlements 設計（Web=Stripe / App=IAP）

## ゴール

- Web課金は Stripe（Checkout + Webhook + Billing Portal）で実装する
- iOS/Android は IAP（必要なら RevenueCat 等）を使い、課金状態の収集は provider ごとに行う
- 画面/機能の出し分けは「共通の Entitlements 層」に統一し、UI は権限の反映のみ行う

## 重要な原則

- **権限の真実**はサーバ側（DB）に置く
- Checkout の success リダイレクトは「成功を示唆」するだけで、確定は **Webhook** を正とする
- `past_due` は **猶予あり**で PRO 扱い（Stripe Billing のリトライ設定に寄せる）

## Entitlements とは

Entitlements = `capabilities`（可否） + `quotas`（上限） + `tier` の集合。

- 例:
  - `analysis.create`（診断できるか）
  - `analysis.monthly_limit`（月の上限: number | null）
  - `coach.chat`（AIコーチ可否）
  - `coach.monthly_messages`（月のメッセージ上限）

実装は `app/types/entitlements.ts` と `app/lib/entitlements.ts`。

## Tier（段階）

- `anonymous`
- `free`
- `pro`

将来的な「PRO内での段階化（制限を設ける）」は、`tier` 追加または `quotas` の調整で吸収する。

## Stripe（Web）フロー

### 1) Checkout 開始

- `POST /api/billing/checkout`
- `mode=subscription`
- `client_reference_id=userId`
- `subscription_data.metadata.userId=userId`
- `allow_promotion_codes=true`
- Price は月額/年額（`STRIPE_PRICE_ID_PRO_MONTHLY/PRO_YEARLY`）を選択

### 2) Webhook（確定点）

- `POST /api/billing/webhook`
- 署名検証（`STRIPE_WEBHOOK_SECRET`）
- 主に以下で状態投影:
  - `checkout.session.completed`（customer/subscription の紐付け）
  - `customer.subscription.updated/deleted`（status/period_end の更新）

status 判定（PRO扱い）:
- PRO: `active` / `trialing` / `past_due`
- 非PRO: `canceled` / `unpaid` など

### 3) 即時反映（補助）

- `POST /api/billing/sync`（`session_id` で Checkout を再取得し、subscription を反映）
- success ページで呼び、Webhookの反映遅延を吸収する

### 4) Portal（解約・カード変更）

- `POST /api/billing/portal`

## DB（本番）最小スキーマ案

- `users`
- `billing_customers`（`user_id`, `provider`, `provider_customer_id`）
- `subscriptions`（`user_id`, `provider`, `provider_subscription_id`, `status`, `price_id`, `current_period_end`, `cancel_at_period_end`, `trial_end`）
- `webhook_events`（冪等化: `provider_event_id`, `processed_at`）

## アプリ（IAP）拡張方針

- Provider は `"apple" | "google" | "revenuecat"` を想定
- どの provider でも `subscriptions` の共通カラムへ正規化し、Entitlements 計算は共通化する

