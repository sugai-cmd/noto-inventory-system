// 蒸留の開始・投入追加・完了の入力チェック。
//
// 画面のAPI（src/routes/distillations.js）と音声入力のコネクタ（src/mcp/）の両方が使う。
// **2か所に書くと片方だけ直したときに入口ごとに通る値が変わる**ので、ここ1か所に置く。

const { z } = require('zod');

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付はYYYY-MM-DD形式で入力してください');
const timeOnly = z.string().regex(/^\d{2}:\d{2}$/, '時刻はHH:MM形式で入力してください');

const startSchema = z.object({
  startedOn: dateOnly.optional(),
  // 蒸留日は時刻を分離して保持する（2.0）。24時間経過アラートの起点になるため必須。
  startedTime: timeOnly,
  plannedDuration: z.string().optional(),
  items: z
    .array(
      z.object({
        tankId: z.number().int().positive(),
        volumeL: z.number().positive(),
        specNote: z.string().optional(),
        note: z.string().optional(),
      })
    )
    .min(1, '投入する原酒を1つ以上指定してください'),
});

const completeSchema = z.object({
  completedOn: dateOnly.optional(),
  completedTime: timeOnly.optional(),
  outputTankId: z.number().int().positive(),
  outputL: z.number().positive('蒸留量は0より大きい値で入力してください'),
  outputAbv: z.number().optional(),
  residue: z
    .object({
      collectedOn: dateOnly.optional(),
      collectedTime: timeOnly, // 残渣回収日も日付/時刻を分離して保持する
      quantity: z.number().nonnegative().optional(),
      abv: z.number().optional(),
      saltStatus: z.string().optional(),
      saltInputQty: z.number().optional(),
      saltConcentration: z.number().optional(),
      // 行き先のタンクは必須（利用者の判断）。自由文の destination はもう受け付けない。
      // 残渣そのものが無い蒸留は residue を送らなければよく、そちらは今までどおり完了できる
      destinationTankId: z
        .number({ required_error: '残渣の払出先タンクを選んでください' })
        .int()
        .positive('残渣の払出先タンクを選んでください'),
    })
    .optional(),
});

// 蒸留中の投入明細を後から足す
const addDetailSchema = z.object({
  tankId: z.number().int().positive(),
  volumeL: z.number().positive('投入量は0より大きい値で入力してください'),
  specNote: z.string().optional(),
  note: z.string().optional(),
});

module.exports = { dateOnly, timeOnly, startSchema, completeSchema, addDetailSchema };
