# Remota

スマホから Claude Code / Codex などの AI コーディングエージェントを操作するための、**セルフホスト型ターミナル（PWA）**。
課金・アカウント登録・広告・テレメトリは一切なし。自分のマシンで動かし、スマホのブラウザで開くだけで使えます。

![アイコン](public/icons/icon-192.png)

## 主な機能

### 複数の機器をまとめて管理（ハブなし）
- 自宅の Mac、会社の Linux、GPU サーバー…と**何台でも登録**し、1つの画面で全セッションを機器ごとに一覧
- **中継サーバーなし**: スマホが各機器へ直接つなぐ。どの機器が止まっても、他の機器はそのまま使える
- 機器リストとトークンはスマホ側に保存。書き出し / 読み込みで別の端末へ移せる
- 承認待ちのある機器が一番上に。オフラインの機器は理由付きで表示
- 通知もスマホが持つ鍵で各機器から直接届く（通知の許可は1回、全機器に自動登録）

### エージェントの仕事をスマホで確認
- **変更の確認**: セッションの作業フォルダの git 差分を、ファイルごとに色付きで表示（新規ファイルも含む）
- **ファイルブラウザ**: 作業フォルダの中身を閲覧（画像もプレビュー）。「入力欄へ」で `@パス` を挿入してエージェントに渡せる
- **検索**: ターミナルの履歴全体をテキストで表示し、検索・ハイライト・コピー

### すぐ始められる
- **QR コードで機器を追加**: アプリ内でカメラ読み取り（カメラが使えない http 接続では「写真から読み取る」）
- **クイック起動**: 「この機器・このフォルダで Claude」をお気に入り登録してワンタップ起動
- **機器の状態**: CPU・メモリ・ディスク・GPU（nvidia-smi があれば）・稼働時間を機器タブに表示

### 安心して使える
- **Face ID / 指紋ロック**: 1分以上離れたらアプリをロック（HTTPS 接続時）
- **画面を消さない**: ターミナル表示中のスリープを防止（対応ブラウザ）

### 途切れない（耐久性）
- **tmux で永続化**: スマホのスリープ・回線切替・**サーバー再起動**でもセッションは消えない
- **差分再開**: 再接続時は「切れた位置から先の出力」だけを受信。画面が再描画されず一瞬で復帰
- **入力を失わない**: 切断中に打った入力はキューに貯めて再接続後に送信。サーバー側で番号管理し、**二重実行もしない**
- **死んだ接続を即検知**: 3秒ごとの生存確認で、iOS で起きがちな「繋がっているように見えて実は切れている」状態を数秒で復旧。アプリ復帰時・オンライン復帰時は即再接続
- **転送量の削減**: 細切れの出力をまとめて送信＋WebSocket 圧縮（モバイル回線向け）
- 下書きは端末に自動保存（アプリを閉じても消えない）

### 操作性
- **承認ボタンを自動生成**: 画面に出た「Do you want to proceed? 1. Yes / 2. … / 3. No」や `[y/N]` を読み取り、ワンタップのボタンとして表示
- **セッション切替**: タイトルをタップして一覧から切替。他のセッションが承認待ちになると、戻るボタンのバッジとアプリ内通知でお知らせ
- **ジェスチャー**: スワイプで慣性スクロール（tmux の履歴も）、**2本指ピンチで文字サイズ変更**、「最新へ↓」ボタン
- **テキスト選択画面**: 履歴全体をネイティブのテキストとして表示し、普通に選択・コピーできる
- キーバー（Esc / ⇧Tab / Ctrl / ^C / 矢印 / ⌫ / 1・2・3 / y・n / PgUp など、**長押しでリピート**、自由に編集可）
- 定型文のワンタップ送信、送信履歴
- テーマ（Midnight / Dracula / Solarized / Light）、触覚フィードバック（対応端末）

### 入力
- **入力欄モード（既定）**: IME・予測変換・音声入力で文章を整えてから送信。ターミナルをタップしてもキーボードが勝手に出ない
- **直接入力モード**: ⌨ ボタンで切替。vim などで1文字ずつ打ちたいとき用
- 複数行はブラケットペーストで「1メッセージ」として送信
- ↑ボタン長押しで「Enter なし送信」、空で送信すると Enter のみ
- 音声入力（Web Speech API / キーボードのマイク）
- 画像・ファイル添付（貼り付けにも対応）→ パスを入力欄に挿入してエージェントに渡せる

### 通知（主要なコーディングエージェントに対応）
- Web Push（iOS 16.4+ のホーム画面アプリ / Android / PC）＋ ntfy・任意 Webhook。通知タップで該当セッションを開く
- **各エージェント公式の仕組みで「完了」「承認待ち」を通知**: Claude Code・Codex CLI・Gemini CLI・OpenCode・pi・GitHub Copilot CLI・Cursor CLI・Factory Droid・Aider。アプリの「機器」タブ →「通知連携」からワンタップで設定
- それ以外のエージェントも、画面の表示（承認プロンプトや作業中の表示）から推定して通知

### HTTPS を内蔵（外部サービス不要）
- Remota が機器ごとに専用の認証局を作り、LAN・VPN の IP アドレスやホスト名の証明書を自動発行（IP が変わっても自動で再発行）
- スマホには最初に一度だけ証明書を登録（QR から開くページが手順を案内し、登録できたか自動で確認）
- 証明書を全機器で共通にすれば、スマホへの登録は1回だけ（`remota ca export` / `remota ca import`）

## Android アプリ

スマホ側はネイティブの Android アプリ（`android/`）です。**証明書のインストールは不要**で、アプリを閉じていても通知が届きます。

- **つなぎ方**: 機器で `remota` を起動すると表示される QR コード（`remota://pair?…`）をアプリで読み取るだけ。QR には機器のアドレス・トークン・**HTTPS の鍵の指紋**が入っていて、アプリはその鍵だけを信頼します（SSH のホスト鍵と同じ考え方）。別の鍵を出す相手には接続しません。
- **複数のアドレス**: 自宅 LAN と VPN など、機器の全アドレスを覚えておき、つながる方を自動で使います。
- **バックグラウンド通知**: [UnifiedPush](https://unifiedpush.org/) を使います。受信用に [ntfy](https://play.google.com/store/apps/details?id=io.heckel.ntfy) など UnifiedPush 対応アプリ（無料・オープンソース）を入れ、アプリの「設定 → プッシュ通知 → 有効化」。通知の中身は端末間で暗号化され、ntfy のサーバーにも読めません。
- **生体認証ロック**: 指紋・顔認証・画面ロックで Remota を保護。

### ビルド

```bash
npm install                    # アプリに同梱する UI の素材を用意
cd android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

Android Studio で `android/` を開いてもビルドできます。GitHub に push すると、Actions がビルドした APK を成果物（remota-android-debug）として保存します。

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

起動すると URL と QR コードが表示されます。スマホで読み取ると設定ページが開くので、

1. 案内に従って**証明書を登録**（初回のみ。iOS: ダウンロード → 設定でプロファイルをインストール → 証明書信頼設定でオン）
2. ページに戻ると自動で確認され、「Remota を開く」が表示される
3. 開いたら **共有 → ホーム画面に追加** でアプリとして使えます（通知・カメラ・Face ID は HTTPS + ホーム画面のアプリで有効）

グローバルコマンドとして使う場合は `npm link` を実行すると `remota` コマンドが使えます。

### バックグラウンドで常駐させる（推奨）

ターミナルを開いたままにする必要はありません。一度登録すれば、ログイン時・再起動後に自動で起動し、落ちても自動で復帰します。

```bash
remota service install     # Linux: systemd ユーザーサービス / macOS: launchd / Windows: タスク スケジューラ
remota service status      # 状態
remota service logs        # ログ
remota service restart     # 再起動（tmux 上のセッションはそのまま）
remota service uninstall   # 解除
remota url                 # スマホで開く URL と QR をいつでも表示
```

Linux でログアウト中や起動直後から動かすには `sudo loginctl enable-linger $USER` が必要です（install 時に自動で試み、できなければ案内します）。

### 複数の機器を登録する

1. 管理したい各機器で Remota を起動します（`npm start`）。起動時に QR コードが表示されます（あとから `remota url` でも表示可）。
2. 1台目は上の手順でスマホに登録し、「ホーム画面に追加」します。
3. 2台目以降は、アプリの「機器」タブ → **「QRで追加」で QR コードを読み取る**か、「URLで追加」に URL をトークン付きのまま貼り付けます。追加時に接続とトークンを確認します。

```
          ┌──▶ 機器A（自宅Mac）
スマホ ───┼──▶ 機器B（GPUサーバー）     各機器に直接接続。中継役の機器はなし
          └──▶ 機器C（会社PC）
```

- アプリ本体はスマホにキャッシュされるので、最初に開いた機器が止まっていても起動し、他の機器を操作できます。
- 機器リストはアプリを開いた URL ごとにスマホへ保存されます。別のスマホやブラウザへは、機器の管理画面の「書き出し」→「読み込み」で移せます（トークンを含むので取り扱いに注意）。
- 機器ごとに証明書の登録が必要です。**全機器で同じ証明書を使うと登録は1回で済みます**:
  ```bash
  remota ca export ca.json     # 1台目で書き出し（秘密鍵を含むので扱いに注意）
  remota ca import ca.json     # 他の機器で読み込み → Remota を再起動
  ```

#### 通知の仕組み
iOS のプッシュ通知は「購読時の鍵で署名された通知」しか受け付けません。Remota ではスマホ側で鍵を作り、通知を有効にしたときと機器を追加したときに各機器へ渡します。どの機器もその鍵で署名してスマホへ直接通知します。

### 外出先から使う

Remota 自体は LAN 内でもそのまま HTTPS で使えます。外出先からは、ポートをインターネットに開放せず、
WireGuard・Tailscale・ZeroTier などの **VPN でスマホと機器を同じネットワークにつなぐ**だけで使えます。
VPN のアドレス（例: 100.x.x.x）も Remota の証明書に自動で含まれるため、追加の HTTPS 設定は不要です。

自前の証明書（独自ドメインなど）を使う場合は、設定ファイルの `tls.cert` / `tls.key` にパスを指定します。
HTTPS を使わない場合は `"https": false`（通知・カメラ・Face ID は使えなくなります）。

### コーディングエージェントの通知連携

画面の表示から推定するだけでなく、各エージェント自身の仕組み（フック・プラグイン）から「完了」「承認待ち」を受け取ると、取りこぼしがありません。
アプリの「機器」タブ →「通知連携」でオン/オフでき、機器上のコマンドでも設定できます。

```bash
remota hooks                    # 対応状況の一覧
remota hooks install            # 見つかったエージェントすべてに設定
remota hooks install opencode pi
remota hooks uninstall codex
```

| エージェント | 設定先 | 通知されるタイミング |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`（hooks） | Stop / Notification |
| Codex CLI | `~/.codex/hooks.json` | Stop / PermissionRequest |
| Gemini CLI | `~/.gemini/settings.json`（hooks） | AfterAgent / Notification |
| OpenCode | `~/.config/opencode/plugins/remota-notify.js` | session.idle / permission.asked |
| pi | `~/.pi/agent/extensions/remota-notify.ts` | agent_end |
| GitHub Copilot CLI | `~/.copilot/hooks/remota-notify.json` | agentStop / notification / permissionRequest |
| Cursor CLI | `~/.cursor/hooks.json` | stop |
| Factory Droid | `~/.factory/settings.json`（hooks） | Stop / Notification |
| Aider | `~/.aider.conf.yml` | 応答待ちになったとき（notifications-command） |

- 既存の設定は残したまま Remota の分だけを追加・削除します。初回の変更前に元のファイルを `*.remota-backup` として保存します。
- Remota の外で起動したエージェントからの通知も届きます（タイトルは「エージェント名 · フォルダ名」）。
- その他のエージェントやスクリプトからは: `remota notify "ビルド完了" --status idle`

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
| `presets` | 主要エージェント一式 | 新規セッション画面の候補（その機器にインストール済みのものだけ表示） |
| `https` | `true` | 内蔵 HTTPS（独自の認証局で証明書を自動発行） |
| `httpPort` | `0`（= port − 1） | 証明書の設定ページ用の HTTP ポート。`false` で無効 |
| `tlsNames` | `[]` | 証明書に追加するホスト名 / IP |
| `tls` | 空 | 自前の証明書・鍵のパス（指定すると内蔵 HTTPS の代わりに使用） |

環境変数 `REMOTA_PORT` `REMOTA_HOST` `REMOTA_TOKEN` `REMOTA_HTTPS` `REMOTA_HTTP_PORT` `REMOTA_TMUX` `REMOTA_HOME` で上書きできます。

### PC から同じセッションに入る

```bash
tmux -L remota ls
tmux -L remota attach -t remota_<id>
```

## セキュリティ

- アクセスにはランダム生成のトークンが必要。アプリは各機器のトークンを毎回明示的に送る（WebSocket はサブプロトコルで送信し、サーバーはトークンを返さない）
- 自動送信される Cookie での接続は同一オリジンのみ許可（他サイトからの乗っ取り対策）。認証失敗は IP ごとにレート制限
- 通信は内蔵 HTTPS で暗号化。証明書の認証局は各機器の中だけで作られ、秘密鍵は外に出ません（`remota ca export` を実行したときを除く）
- **このアプリはシェルへのフルアクセスを提供します。** インターネットへ直接公開せず、LAN 内または VPN 経由で使ってください
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
src/workspace.js   git 差分・ファイル閲覧・機器の状態（読み取り専用）
src/agents.js      各コーディングエージェントの通知連携（フック・プラグインの設定）
src/tls.js         内蔵 HTTPS（認証局と証明書の発行・更新）
src/setup-page.js  証明書の登録を案内する設定ページ
src/notify.js      Web Push と Webhook
public/            PWA（xterm.js、Service Worker、マニフェスト）
```

## ライセンス

MIT
