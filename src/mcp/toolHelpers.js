// MCPのツール定義で共通に使う部品（入力の形と、結果の返し方）。

const { z } = require('zod');
const { McpInputError } = require('./tankLookup');
const { errorBody } = require('./writeFlow');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');
const time = z.string().regex(/^\d{2}:\d{2}$/).describe('HH:MM（24時間）');
const tankRef = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe('タンクのID（数値）、または名前・容器ID（例「タンク2」「SP-2405-01」）。1つに決まらなければ候補を返します');
const distillationRef = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe('蒸留記録のID（数値）、または蒸留コード（例「D2611120001」）');
const preview = z
  .boolean()
  .optional()
  .describe('true：保存せず、保存される内容・タンクの変化・注意点だけ返す。確認表を作るときは必ず true で呼ぶ');
const requestKey = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe('本登録（preview=false）で必須。確認表ごとに一意な文字列。同じキーで再送しても2件目は作られない');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const WRITE_FLOW =
  '必ず先に preview=true で呼び、結果（warnings・在庫や液量の変化）から確認表を作って利用者の「OK」を得てから、' +
  '同じ内容で preview=false と requestKey を付けて本登録する。';

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  const body =
    err instanceof McpInputError || (err.status && err.status < 500)
      ? errorBody(err)
      : { code: 'internal_error', message: `サーバー側でエラーが起きました: ${err.message}` };
  if (!(err instanceof McpInputError) && !(err.status && err.status < 500)) {
    console.error('[mcp] ツールの実行に失敗しました:', err);
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: body }, null, 2) }] };
}

function wrap(fn) {
  return async (args) => {
    try {
      return ok(fn(args ?? {}));
    } catch (err) {
      return fail(err);
    }
  };
}

const ref = (what) =>
  z.union([z.number().int().positive(), z.string().min(1)]).describe(`${what}のID（数値）、または名前・コード。1つに決まらなければ候補を返します`);

module.exports = { z, date, time, tankRef, distillationRef, preview, requestKey, READ, WRITE, WRITE_FLOW, wrap, ref };
