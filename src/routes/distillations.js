const express = require('express');
const { z } = require('zod');
const distillationService = require('../services/distillationService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

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
      destination: z.string().optional(),
    })
    .optional(),
});

// 24時間以上「蒸留中」のままの蒸留を警告する（旧 getStaleDistillationAlerts）
router.get('/alerts', (req, res) => {
  const thresholdHours = Number(req.query.hours) || 24;
  res.json(distillationService.getStaleDistillationAlerts({ thresholdHours }));
});

router.get('/', (req, res) => {
  res.json(
    distillationService.list({
      status: req.query.status,
      limit: Math.min(Number(req.query.limit) || 100, 500),
    })
  );
});

router.get('/:id', (req, res) => {
  const distillation = distillationService.findById(Number(req.params.id));
  if (!distillation) return res.status(404).json({ error: 'not_found' });
  res.json(distillation);
});

// 蒸留開始：ヘッダ＋投入明細＋原料受払（払出）を1トランザクションで記録
router.post('/', validateRequest(startSchema), (req, res, next) => {
  try {
    res.status(201).json(distillationService.submitDistillationStart(req.body));
  } catch (err) {
    next(err);
  }
});

// 蒸留完了：蒸留記録の更新＋浄酎タンクへの継足＋残渣回収記録
router.post('/:id/complete', validateRequest(completeSchema), (req, res, next) => {
  try {
    res.json(distillationService.completeDistillation(Number(req.params.id), req.body));
  } catch (err) {
    next(err);
  }
});

// 投入明細の部分取消（原酒を元のタンクへ戻す）
router.post(
  '/details/:detailId/cancel',
  validateRequest(z.object({ reason: z.string().optional() })),
  (req, res, next) => {
    try {
      res.json(
        distillationService.cancelDistillationDetailItem(Number(req.params.detailId), req.body)
      );
    } catch (err) {
      next(err);
    }
  }
);

// 未対応アラートの消込
router.post('/:id/acknowledge-alert', (req, res, next) => {
  try {
    res.json(
      distillationService.acknowledgeStaleAlert(Number(req.params.id), req.body ?? {}, req.user)
    );
  } catch (err) {
    next(err);
  }
});

// 蒸留中の投入明細を後から足す（誤ったタンクを取り消してから入れ直すため）
const addDetailSchema = z.object({
  tankId: z.number().int().positive(),
  volumeL: z.number().positive('投入量は0より大きい値で入力してください'),
  specNote: z.string().optional(),
  note: z.string().optional(),
});

router.post('/:id/details', validateRequest(addDetailSchema), (req, res, next) => {
  try {
    res.status(201).json(
      distillationService.addDistillationDetailItem(Number(req.params.id), req.body, req.user)
    );
  } catch (err) {
    next(err);
  }
});

/**
 * 蒸留記録の本体を直す。
 *
 * **在庫に響く項目は受け付けない。** 出力量・度数・出力タンク・状態を変えると
 * タンクの中身と瓶詰めの元が動くので、ここでは扱わない（別の口で扱う）。
 * 送られてきても strict で400にして、黙って無視しない。
 */
const updateDistillationSchema = z
  .object({
    startedOn: dateOnly.optional(),
    startedTime: timeOnly.optional(),
    plannedDuration: z.string().nullish(),
    inputSummary: z.string().nullish(),
    note: z.string().nullish(),
  })
  .strict();

const residueSchema = z.object({
  collectedOn: dateOnly.optional(),
  collectedTime: timeOnly,
  quantity: z.number().nonnegative().nullish(),
  abv: z.number().nullish(),
  saltStatus: z.string().nullish(),
  saltInputQty: z.number().nullish(),
  saltConcentration: z.number().nullish(),
  destination: z.string().nullish(),
});

// 残渣回収記録を足す（移行で漏れていたぶんを入れられるように）
router.post('/:id/residues', validateRequest(residueSchema), (req, res, next) => {
  try {
    res.status(201).json(distillationService.addResidue(Number(req.params.id), req.body, req.user));
  } catch (err) {
    next(err);
  }
});

// 残渣回収記録を直す
router.patch(
  '/residues/:residueId',
  validateRequest(residueSchema.partial().strict()),
  (req, res, next) => {
    try {
      res.json(
        distillationService.updateResidue(Number(req.params.residueId), req.body, req.user)
      );
    } catch (err) {
      next(err);
    }
  }
);

// 残渣回収記録を消す
router.delete('/residues/:residueId', (req, res, next) => {
  try {
    res.json(distillationService.deleteResidue(Number(req.params.residueId), req.user));
  } catch (err) {
    next(err);
  }
});

// **/:id は最後に置く。** Expressは書いた順に当てるので、これを先に置くと
// PATCH /api/distillations/residues/5 が id="residues" として拾われる
router.patch('/:id', validateRequest(updateDistillationSchema), (req, res, next) => {
  try {
    res.json(distillationService.updateDistillation(Number(req.params.id), req.body, req.user));
  } catch (err) {
    next(err);
  }
});


module.exports = router;
