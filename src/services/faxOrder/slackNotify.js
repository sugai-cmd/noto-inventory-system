// Slackへの通知。
//
// 2通りに対応する（.env で設定。両方あればボットを使う）
//   - ボット:   SLACK_BOT_TOKEN（xoxb-…、権限 chat:write）と SLACK_CHANNEL
//               SLACK_CHANNEL にメンバーID（U…）を入れると、ボットからそのメンバーへのDMになる
//   - Webhook:  SLACK_WEBHOOK_URL（Incoming Webhook。決まったチャンネルに投稿）
// どちらも無ければ何もしない（取込は止めない）。

async function notifySlack(text, env = process.env, fetchFn = fetch) {
  if (!text) return { sent: false, reason: 'nothing' };

  if (env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL) {
    const res = await fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Slackへの通知に失敗しました: ${body.error ?? res.status}`);
    return { sent: true, via: 'bot' };
  }

  if (env.SLACK_WEBHOOK_URL) {
    const res = await fetchFn(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slackへの通知に失敗しました: HTTP ${res.status}`);
    return { sent: true, via: 'webhook' };
  }

  return { sent: false, reason: 'not_configured' };
}

module.exports = { notifySlack };
