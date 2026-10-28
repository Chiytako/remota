'use strict';

// The plain-HTTP first-contact page: install Remota's CA on the phone, confirm it's trusted, then
// continue to the HTTPS app with the login token carried along in the URL fragment.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderSetupPage({ httpsPort, caInfo, hostname }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0c0f">
<title>Remota のセットアップ</title>
<style>
  :root { color-scheme: dark; --bg:#0b0c0f; --surface:#15161a; --surface-2:#1d1f24; --line:rgba(255,255,255,.08); --text:#f3f4f6; --text-2:#aab0bb; --text-3:#767c88; --accent:#7c9cff; --ok:#3ecf8e; --warn:#f5b83d; }
  @media (prefers-color-scheme: light) { :root { color-scheme: light; --bg:#f2f3f7; --surface:#fff; --surface-2:#f1f2f6; --line:rgba(15,20,30,.08); --text:#12151b; --text-2:#4f5663; --text-3:#868c98; --accent:#3461f5; --ok:#138a52; --warn:#a96800; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width:520px; margin:0 auto; padding:calc(env(safe-area-inset-top) + 28px) 18px 40px; }
  h1 { font-size:28px; margin:0 0 6px; letter-spacing:-.01em; }
  .lead { color:var(--text-2); margin:0 0 22px; }
  .status { display:flex; gap:12px; align-items:center; padding:14px 16px; border-radius:16px; background:var(--surface); border:1px solid var(--line); margin-bottom:18px; font-weight:600; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--warn); flex:none; }
  .status.ok .dot { background:var(--ok); }
  ol { list-style:none; padding:0; margin:0 0 18px; display:grid; gap:10px; counter-reset:s; }
  li { counter-increment:s; display:grid; grid-template-columns:30px 1fr; gap:4px 12px; padding:14px 16px; border-radius:16px; background:var(--surface); border:1px solid var(--line); }
  li::before { content:counter(s); grid-row:1/3; width:28px; height:28px; border-radius:50%; background:var(--surface-2); color:var(--accent); display:grid; place-items:center; font-weight:800; font-size:14px; }
  li b { display:block; }
  li span { color:var(--text-2); font-size:14px; }
  .btn { display:flex; align-items:center; justify-content:center; width:100%; padding:14px 18px; border-radius:14px; border:none; font:inherit; font-weight:700; text-decoration:none; background:var(--surface-2); color:var(--text); margin-top:10px; }
  .btn.primary { background:var(--accent); color:#0b0c0f; }
  .muted { color:var(--text-3); font-size:13px; }
  code { font:13px ui-monospace,Menlo,monospace; background:var(--surface-2); padding:1px 5px; border-radius:5px; word-break:break-all; }
  details { margin-top:18px; }
  summary { cursor:pointer; color:var(--text-2); font-size:14px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>Remota をはじめる</h1>
  <p class="lead">${esc(hostname)} に安全（HTTPS）につなぐため、最初に一度だけこの機器の証明書をスマホに登録します。</p>

  <div class="status" id="status"><span class="dot"></span><span id="status-text">証明書を確認しています…</span></div>

  <section id="ready" hidden>
    <a class="btn primary" id="open">Remota を開く</a>
    <p class="muted">開いたら共有メニューから「ホーム画面に追加」すると、通知が使えるアプリになります。</p>
  </section>

  <section id="steps" hidden>
    <ol id="steps-ios" hidden>
      <li><b>証明書をダウンロード</b><span>下のボタン →「許可」を選びます。</span></li>
      <li><b>プロファイルをインストール</b><span>設定 → 一般 → VPNとデバイス管理 →「Remota Local CA」→ インストール</span></li>
      <li><b>証明書を信頼する</b><span>設定 → 一般 → 情報 → 証明書信頼設定 →「Remota Local CA」をオン</span></li>
      <li><b>このページに戻る</b><span>自動で確認し、「Remota を開く」が表示されます。</span></li>
    </ol>
    <ol id="steps-android" hidden>
      <li><b>証明書をダウンロード</b><span>下のボタンから保存します。</span></li>
      <li><b>CA 証明書としてインストール</b><span>設定 → セキュリティ → 暗号化と認証情報 → 証明書のインストール → CA 証明書 → ダウンロードした remota-ca.crt</span></li>
      <li><b>このページに戻る</b><span>自動で確認し、「Remota を開く」が表示されます。</span></li>
    </ol>
    <ol id="steps-desktop" hidden>
      <li><b>証明書をダウンロード</b><span>下のボタンから保存します。</span></li>
      <li><b>信頼済みのルート証明書として登録</b><span>macOS: キーチェーンアクセスで追加し「常に信頼」。Windows: ダブルクリック →「信頼されたルート証明機関」に配置。</span></li>
      <li><b>このページに戻る</b><span>自動で確認します。</span></li>
    </ol>
    <a class="btn primary" href="/remota-ca.crt">証明書をダウンロード</a>
    <button class="btn" id="recheck">もう一度確認する</button>
  </section>

  <details>
    <summary>この証明書について</summary>
    <p class="muted">Remota がこの機器の中で作った専用の認証局です。この機器と、同じ証明書を読み込んだあなたの機器にだけ使われます。</p>
    <p class="muted">${esc(caInfo.subject)}<br>SHA-256: <code>${esc(caInfo.fingerprint)}</code></p>
    <p class="muted">複数の機器で同じ証明書を使うと、スマホへの登録は1回で済みます: 1台目で <code>remota ca export ca.json</code>、他の機器で <code>remota ca import ca.json</code></p>
  </details>
</main>
<script>
  const HTTPS_PORT = ${Number(httpsPort)};
  const target = 'https://' + location.hostname + ':' + HTTPS_PORT;
  const hash = location.hash || '';
  const ua = navigator.userAgent;
  const platform = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';
  document.getElementById('steps-' + platform).hidden = false;
  document.getElementById('open').href = target + '/' + hash;

  async function check() {
    document.getElementById('status-text').textContent = '証明書を確認しています…';
    let ok = false;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(target + '/api/ping', { cache: 'no-store', signal: ctrl.signal });
      ok = res.ok;
    } catch (e) {}
    document.getElementById('status').classList.toggle('ok', ok);
    document.getElementById('status-text').textContent = ok ? '証明書は信頼されています' : '証明書がまだ登録されていません';
    document.getElementById('ready').hidden = !ok;
    document.getElementById('steps').hidden = ok;
  }
  document.getElementById('recheck').addEventListener('click', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
</script>
</body>
</html>`;
}

module.exports = { renderSetupPage };
