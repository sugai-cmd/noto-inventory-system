// MCPのツール定義。**コネクタから呼べるのは、ここと registrationToolDefs.js に書いたものだけ。**
// できるのは「新しい記録の登録」と、そのための読み取りだけ。
// 取消・修正・削除はコネクタから呼べないようにするため、ここには足さない（画面で行う）。
//
// 中身は distillationTools.js / registrationTools.js にあり、ここは入力の形（Claudeに見せる説明）と、
// 結果をMCPの返し方に包むことだけを受け持つ。

const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const tools = require('./distillationTools');
const { date, time, tankRef, distillationRef, preview, requestKey, READ, WRITE, WRITE_FLOW, wrap } = require('./toolHelpers');
const { registerRegistrationTools } = require('./registrationToolDefs');

/**
 * @param {object} ctx
 * @param {object} ctx.actor - 登録者（OAuthでログインした利用者。toPublicUser の形）
 * @param {string} [ctx.clientName] - コネクタの名前（操作ログに残す）
 */
function buildMcpServer(ctx) {
  const server = new McpServer(
    { name: 'noto-inventory', version: '2.0.0' },
    {
      instructions:
        'NOTO Naorai の受注管理システムに、新しい記録を登録するためのツール群' +
        '（蒸留・原酒入荷・瓶詰め・箱詰め・タンク移動・資材入荷・受注・出荷・返品・無償出荷・委託販売報告・見積・入金・マスタ）。' +
        '取消・修正・削除はできない（画面で行う）。登録は ' + WRITE_FLOW +
        ' タンク・得意先・商品などが1つに決まらないときは候補が返るので、利用者に選んでもらう。',
    }
  );

  server.registerTool(
    'list_tanks',
    {
      title: 'タンク一覧',
      description: 'タンクの一覧（名前・種別＝原酒／浄酎／残渣・現在液量L・度数%・最大液量L）。kind で種別を絞れる。',
      inputSchema: { kind: z.enum(['原酒', '浄酎', '残渣']).optional() },
      annotations: READ,
    },
    wrap((args) => ({ tanks: tools.listTanks(args) }))
  );

  server.registerTool(
    'list_active_distillations',
    {
      title: '蒸留中の記録',
      description: '状態が「蒸留中」の蒸留記録（ID・蒸留コード・投入開始日時・投入した原酒と量）。投入追加・完了の対象を探すのに使う。',
      inputSchema: {},
      annotations: READ,
    },
    wrap(() => ({ distillations: tools.listActiveDistillations() }))
  );

  server.registerTool(
    'get_distillation',
    {
      title: '蒸留記録の詳細',
      description: '蒸留記録1件の詳細（投入明細・完了情報・払出・残渣）。',
      inputSchema: { distillation: distillationRef },
      annotations: READ,
    },
    wrap((args) => tools.getDistillation(args))
  );

  server.registerTool(
    'get_distillation_options',
    {
      title: '蒸留の選択肢',
      description: '登録で選べる値（投入元＝原酒タンク、払出先＝浄酎タンク、残渣タンク、食塩の有無、蒸留設定時間の書き方）。',
      inputSchema: {},
      annotations: READ,
    },
    wrap(() => tools.getDistillationOptions())
  );

  server.registerTool(
    'start_distillation',
    {
      title: '蒸留開始',
      description: '蒸留を開始する（投入する原酒の払出を記録する）。' + WRITE_FLOW,
      inputSchema: {
        startedOn: date.describe('投入開始日 YYYY-MM-DD'),
        startedTime: time.describe('投入開始時刻 HH:MM'),
        plannedDuration: z.string().optional().describe('蒸留設定時間（例「8時間」）。「N時間」「N時間M分」にそろえて保存する'),
        items: z
          .array(
            z.object({
              tank: tankRef,
              volumeL: z.number().positive().describe('投入量 L'),
              note: z.string().optional().describe('備考'),
            })
          )
          .min(1)
          .describe('投入する原酒（複数可）'),
        preview,
        requestKey,
      },
      annotations: WRITE,
    },
    wrap((args) => tools.startDistillation(args, ctx))
  );

  server.registerTool(
    'add_distillation_input',
    {
      title: '蒸留中の投入追加',
      description: '蒸留中の記録に、原酒の投入を1件足す。' + WRITE_FLOW,
      inputSchema: {
        distillation: distillationRef,
        tank: tankRef,
        volumeL: z.number().positive().describe('投入量 L'),
        note: z.string().optional().describe('備考'),
        preview,
        requestKey,
      },
      annotations: WRITE,
    },
    wrap((args) => tools.addDistillationInput(args, ctx))
  );

  server.registerTool(
    'complete_distillation',
    {
      title: '蒸留の完了報告',
      description:
        '蒸留を完了し、蒸留した液を払出先（浄酎）タンクへ継ぎ足す。残渣を回収したときは residue を付ける（払出先の残渣タンクは必須）。' +
        WRITE_FLOW,
      inputSchema: {
        distillation: distillationRef,
        completedOn: date.describe('完了日 YYYY-MM-DD'),
        completedTime: time.describe('完了時刻 HH:MM'),
        outputL: z.number().positive().describe('蒸留量 L'),
        outputAbv: z.number().optional().describe('度数 %'),
        outputTank: tankRef.describe('払出先タンク（浄酎）。ID または名前'),
        residue: z
          .object({
            quantityL: z.number().nonnegative().optional().describe('残渣の回収量 L'),
            abv: z.number().optional().describe('残渣の度数 %'),
            destinationTank: tankRef.describe('残渣の払出先タンク（残渣タンク）。ID または名前'),
            saltStatus: z.enum(['有', '無']).optional().describe('食塩の有無（省略時は「無」）'),
            saltInputQty: z.number().nonnegative().optional().describe('食塩の投入量 g（「有」のとき）'),
            saltConcentration: z.number().optional().describe('塩分濃度 %'),
          })
          .optional()
          .describe('残渣回収と食塩。残渣を記録しないときは省く'),
        preview,
        requestKey,
      },
      annotations: WRITE,
    },
    wrap((args) => tools.completeDistillation(args, ctx))
  );

  registerRegistrationTools(server, ctx);

  return server;
}

module.exports = { buildMcpServer };
