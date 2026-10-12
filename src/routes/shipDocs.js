// 送り状・納品書の登録を受注画面から手動で動かす（FAXが追加で届いた日など）。
//
// 実際の処理は scripts/ship-docs.js を別プロセスで動かす。Chromeを開いて数十秒〜数分かかるので、
// 画面の操作を待たせず、結果は毎朝の実行と同じくSlackに届く。
// ブラウザはサーバーのMac上で動く（どのPCからボタンを押しても同じ）。

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const express = require('express');
const shipDocsService = require('../services/shipDocsService');

const router = express.Router();
const ROOT = path.resolve(__dirname, '..', '..');
const LOCK = path.join(ROOT, 'logs', 'ship-docs', '.lock');

/** まだ登録していない対象の件数（ボタンの横に出す） */
router.get('/status', (req, res) => {
  const { customers, pending } = shipDocsService.findTargets();
  res.json({
    running: fs.existsSync(LOCK),
    customers: customers.map((c) => c.name),
    pending,
  });
});

router.post('/run', (req, res) => {
  if (fs.existsSync(LOCK)) {
    return res.status(409).json({ error: 'running', message: 'いま登録を実行中です。終わったらSlackに届きます' });
  }
  fs.mkdirSync(path.join(ROOT, 'logs', 'ship-docs'), { recursive: true });
  const log = fs.openSync(path.join(ROOT, 'logs', 'ship-docs.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'ship-docs.js'), '--manual'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  res.status(202).json({ message: '送り状・納品書の登録を始めました。結果はSlackに届きます（数分かかります）' });
});

module.exports = router;
