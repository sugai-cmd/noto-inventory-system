// マスタのCSV一括登録（得意先・資材・酒蔵）。

const express = require('express');
const { z } = require('zod');
const masterImportService = require('../services/masterImportService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const importSchema = z.object({
  kind: z.enum(['customers', 'materials', 'breweries', 'products', 'productRecipes', 'tanks']),
  csv: z.string().min(1, 'CSVを貼り付けてください'),
  dryRun: z.boolean().optional(),
});

router.get('/template/:kind', (req, res, next) => {
  try {
    res.json(masterImportService.templateFor(req.params.kind));
  } catch (err) {
    next(err);
  }
});

// ファイルをそのまま受け取って中身を返す。
// 表計算ソフトで開いてコピーする手間を無くすため。取り込みは従来どおり
// 画面で中身を確認してから行うので、ここでは文字にして返すだけにする。
//
// 5MBを上限にしているのは、マスタのCSVがこれを超えることは実務上なく、
// 大きなファイルを丸ごとメモリに載せる必要もないため。
router.post(
  '/decode',
  express.raw({ type: '*/*', limit: '5mb' }),
  (req, res, next) => {
    try {
      const { text, encoding } = masterImportService.decodeUpload(req.body);
      res.json({ text, encoding });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/', validateRequest(importSchema), (req, res, next) => {
  try {
    res.json(masterImportService.importCsv(req.body.kind, req.body.csv, { dryRun: req.body.dryRun }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
