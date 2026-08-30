const express = require('express');
const { z } = require('zod');
const { getConnection } = require('../db/connection');
const tankService = require('../services/tankService');
const { validateRequest } = require('../middlewares/validateRequest');

const createSchema = z.object({
  code: z.string().min(1, '容器IDは必須です'),
  name: z.string().min(1, '容器名称は必須です'),
  containerType: z.string().optional(),
  maxVolumeL: z.number().positive().optional(),
  location: z.string().optional(),
  status: z.string().optional(),
  gaugeConstant: z.number().optional(),
  initialVolumeL: z.number().nonnegative().optional(),
  currentAbv: z.number().optional(),
  note: z.string().optional(),
});
const updateSchema = createSchema.partial().omit({ code: true, initialVolumeL: true });

const router = express.Router();

/**
 * タンクモニター（DB_SCHEMA_DESIGN.md 3章 v_tank_monitor）。
 * 旧「タンクモニター」シートが持っていた300ml/700ml換算本数もここで算出する
 * （6-5で「浮いている」と指摘されていたシートの正式な置き換え先）。
 *
 * 注意: このビューは tank_ledger（浄酎容器変動履歴）のみを集計するため、
 * 原酒タンクの残量（raw_sake_ledger 側）は含まれない。8-8の既知の注意点を参照。
 */
router.get('/monitor', (req, res) => {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT v.tank_id, v.name, v.current_volume_l, v.max_volume_l, v.fill_rate,
              t.code, t.container_type, t.location, t.status, t.current_abv
       FROM v_tank_monitor v
       JOIN tanks t ON t.id = v.tank_id
       ORDER BY t.code`
    )
    .all();

  res.json(
    rows.map((r) => ({
      ...r,
      bottles300ml: r.current_volume_l != null ? Math.floor((r.current_volume_l * 1000) / 300) : null,
      bottles700ml: r.current_volume_l != null ? Math.floor((r.current_volume_l * 1000) / 700) : null,
    }))
  );
});

router.get('/', (req, res) => {
  const db = getConnection();
  res.json(db.prepare('SELECT * FROM tanks ORDER BY code').all());
});

router.get('/:id', (req, res) => {
  const db = getConnection();
  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(Number(req.params.id));
  if (!tank) return res.status(404).json({ error: 'not_found' });
  res.json(tank);
});

router.post('/', validateRequest(createSchema), (req, res, next) => {
  try {
    res.status(201).json(tankService.registerTank(req.body, req.user));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateRequest(updateSchema), (req, res, next) => {
  try {
    const updated = tankService.updateTank(Number(req.params.id), req.body, req.user);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
