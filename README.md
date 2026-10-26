# Remota

スマホから Claude Code / Codex などの AI コーディングエージェントを操作するための、**セルフホスト型ターミナル（PWA）**。
課金・アカウント登録・広告・テレメトリは一切なし。自分のマシンで動かし、スマホのブラウザで開くだけで使えます。

![アイコン](public/icons/icon-192.png)

## 主な機能

| 機能 | 内容 |
| --- | --- |
| 永続セッション | tmux 上でセッションを動かすため、スマホのスリープ・回線切替・**サーバー再起動**でも作業が消えない。自動再接続し、画面も復元 |
| 複数セッション | 一覧画面で各セッションの状態（実行中 / 待機 / **承認待ち**）と最新出力をプレビュー |
| エージェント状態検知 | 出力から「承認待ち」「完了」を自動判定。Claude Code のフックと連携すれば確実に検知 |
| プッシュ通知 | Web Push（iOS 16.4+ のホーム画面アプリ / Android / PC）＋ ntfy・任意 Webhook。通知タップで該当セッションを開く |
| 入力欄（コンポーズ） | 日本語 IME・音声入力（キーボードのマイク / Web Speech API）で文章を整えてから送信。複数行はブラケットペーストで1メッセージとして送信 |
| キーバー | Esc / Tab / ⇧Tab / Ctrl（スティッキー）/ ^C / 矢印 / 1・2・3 / y・n / PgUp・PgDn など。**自由に編集可能** |
| 定型文 | 「続けてください」「/compact」などをワンタップ送信。編集可能 |
| 画像・ファイル添付 | スクショなどをアップロードしてパスを入力欄に挿入（エージェントにそのまま渡せる）。貼り付けにも対応 |
| スクロール | スワイプで tmux の履歴をスクロール（copy-mode を意識せずに使える） |
| その他 | 文字サイズ変更、遅延(ms)表示、画面テキストのコピー、アプリバッジ（承認待ち件数）、オフラインでもアプリ起動 |

## 必要なもの

- Node.js 18 以上（ビルドツール: macOS は Xcode CLT、Linux は `build-essential` と `python3` — node-pty のビルドに使用）
- tmux（推奨。無くても動くが、サーバー再起動でセッションが消える）

## セットアップ

```bash
git clone https://github.com/Chiytako/remota.git
cd remota
npm install
npm start          # または: node bin/remota.js
```

起動するとログイン用 URL と QR コードが表示されます。スマホで読み取って開き、
**共有 → ホーム画面に追加** するとアプリとして使えます。

グローバルコマンドとして使う場合は `npm link` を実行すると `remota` コマンドが使えます。

### 外出先から使う（推奨: Tailscale）

ポート開放はせず、[Tailscale](https://tailscale.com/) などの VPN 経由で接続してください。
iOS のプッシュ通知とクリップボードには **HTTPS** が必要です。Tailscale なら次の1行で HTTPS 化できます。

```bash
tailscale serve --bg 7681
# → https://<マシン名>.<tailnet>.ts.net/ でアクセス
```

自前の証明書を使う場合は設定ファイルの `tls.cert` / `tls.key` にパスを指定します。

### 通知を確実にする（Claude Code フック）

出力からの自動判定に加えて、Claude Code のフックから通知させると取りこぼしがありません。

```bash
remota hooks   # ~/.claude/settings.json に貼る JSON を表示
```

Remota 内で起動したセッションには `REMOTA_SESSION` 環境変数が入っているため、通知タップで該当セッションが開きます。
フックは任意のスクリプトからも使えます: `remota notify "ビルド完了" --title CI`

### ntfy / Webhook

設定ファイルの `webhookUrl` に `https://ntfy.sh/<自分のトピック>` を入れると ntfy アプリにも通知されます。
それ以外の URL には `{ title, body, sessionId }` の JSON を POST します。

## 設定

設定ファイル: `~/.config/remota/config.json`（初回起動時に自動生成。トークンと VAPID 鍵もここに保存）

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `host` / `port` | `0.0.0.0` / `7681` | 待ち受けアドレス |
| `tmux` | `"auto"` | `true` / `false` / `"auto"`（インストール済みなら使う） |
| `defaultCwd` | ホーム | 新規セッションの既定ディレクトリ |
| `idleSeconds` | `8` | 出力が止まってから「完了」とみなすまでの秒数 |
| `webhookUrl` | `""` | ntfy または任意の Webhook |
| `presets` | Shell / Claude Code / Codex | 新規セッション画面の起動プリセット |
| `tls` | 空 | HTTPS 用の証明書・鍵のパス |

環境変数 `REMOTA_PORT` `REMOTA_HOST` `REMOTA_TOKEN` `REMOTA_TMUX` `REMOTA_HOME` で上書きできます。

### PC から同じセッションに入る

```bash
tmux -L remota ls
tmux -L remota attach -t remota_<id>
```

## セキュリティ

- アクセスにはランダム生成のトークンが必要（Cookie にはトークン自体ではなく HMAC を保存、HttpOnly / SameSite=Strict）
- ログイン失敗は IP ごとにレート制限、WebSocket は同一オリジンのみ許可
- **このアプリはシェルへのフルアクセスを提供します。** インターネットへ直接公開せず、VPN（Tailscale 等）経由で使ってください
- トークンの再発行: `remota token --rotate`

## 開発

```bash
npm test
```

構成:

```
bin/remota.js      CLI（start / url / token / notify / hooks）
src/server.js      HTTP API・WebSocket・認証・アップロード
src/sessions.js    PTY / tmux セッション管理、状態判定と通知のトリガー
src/detect.js      出力から「承認待ち」「作業中」を推定
src/notify.js      Web Push と Webhook
public/            PWA（xterm.js、Service Worker、マニフェスト）
```

## ライセンス

MIT
