// マスタのCSV一括登録（得意先・資材・酒蔵）。

const express = require('express');
const { z } = require('zod');
const masterImportService = require('../services/masterImportService');
const { validateRequest } = require('../middlewares/validateRequest');

const router = express.Router();

const importSchema = z.object({
  kind: z.enum(['customers', 'materials', 'breweries', 'products', 'productRecipes']),
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

router.post('/', validateRequest(importSchema), (req, res, next) => {
  try {
    res.json(masterImportService.importCsv(req.body.kind, req.body.csv, { dryRun: req.body.dryRun }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
