const express = require('express');
const { getConnection } = require('../db/connection');

const router = express.Router();

/**
 * 資材在庫モニター（DB_SCHEMA_DESIGN.md 7-1で新設した v_material_stock）。
 * 現行スプレッドシートには存在しなかった「資材の現在庫数」がここで一覧できる。
 * 適正在庫数を下回っているものに shortage フラグを立てて返す。
 */
router.get('/stock', (req, res) => {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT s.material_id, s.name, s.current_stock,
              m.unit, m.proper_stock_qty, m.lot_size, m.supplier_name, m.lead_time_days
       FROM v_material_stock s
       JOIN materials m ON m.id = s.material_id
       ORDER BY s.name`
    )
    .all();

  res.json(
    rows.map((r) => ({
      ...r,
      shortage: r.proper_stock_qty != null && r.current_stock < r.proper_stock_qty,
    }))
  );
});

router.get('/', (req, res) => {
  const db = getConnection();
  res.json(db.prepare('SELECT * FROM materials ORDER BY name').all());
});

router.get('/:id', (req, res) => {
  const db = getConnection();
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.status(404).json({ error: 'not_found' });
  res.json(material);
});

module.exports = router;
