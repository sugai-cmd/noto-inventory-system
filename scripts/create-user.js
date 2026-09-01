#!/usr/bin/env node
//
// ログインユーザーを作成するCLI。最初の管理者を作るときに使う。
//
//   node scripts/create-user.js                      # 対話形式で入力する
//   node scripts/create-user.js --list               # 登録済みユーザーの一覧
//
// パスワードはコマンドライン引数では受け取らない
// （シェルの履歴やプロセス一覧に残ってしまうため）。

const readline = require('node:readline');
const { migrate } = require('../src/db/migrate');
const authService = require('../src/services/authService');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/**
 * パスワードを画面に表示せずに読み取る。
 */
function askPassword(rl, question) {
  return new Promise((resolve) => {
    const onKeypress = (char) => {
      // 入力中の文字を消し、プロンプトだけ出したままにする
      if (char === '\n' || char === '\r' || char === '') return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question);
    };

    process.stdin.on('data', onKeypress);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onKeypress);
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  migrate();

  if (process.argv.includes('--list')) {
    const users = authService.listUsers();
    if (!users.length) {
      console.log('ユーザーがまだ登録されていません。');
      return;
    }
    console.log('ログインID           権限     表示名               最終ログイン');
    console.log('-'.repeat(72));
    for (const u of users) {
      console.log(
        `${u.username.padEnd(20)} ${u.role.padEnd(8)} ${(u.displayName ?? '').padEnd(20)} ${u.lastLoginAt ?? '-'}`
      );
    }
    return;
  }

  const isFirstUser = authService.countUsers() === 0;
  if (isFirstUser) {
    console.log('登録済みのユーザーがいないため、最初の管理者を作成します。\n');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const username = await ask(rl, 'ログインID: ');
    const displayName = await ask(rl, '表示名（空欄ならログインIDと同じ）: ');
    const password = await askPassword(rl, `パスワード（${authService.MIN_PASSWORD_LENGTH}文字以上）: `);
    const confirm = await askPassword(rl, 'パスワード（確認）: ');

    if (password !== confirm) {
      console.error('\nパスワードが一致しません。中止しました。');
      process.exitCode = 1;
      return;
    }

    // 最初の1人は必ず管理者。2人目以降は選べる
    let role = 'admin';
    if (!isFirstUser) {
      const answer = await ask(rl, '管理者にしますか？ (y/N): ');
      role = answer.toLowerCase() === 'y' ? 'admin' : 'staff';
    }

    const user = authService.createUser({ username, displayName, password, role });
    console.log(`\nユーザー「${user.username}」（${user.role}）を作成しました。`);
  } catch (err) {
    console.error(`\nエラー: ${err.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
