// ダッシュボードの追加集計（未入金／本日の出荷予定／次回注文予測）。

const express = require('express');
const dashboardService = require('../services/dashboardService');

const router = express.Router();

router.get('/unpaid', (req, res) => {
  res.json(dashboardService.listUnpaidOrders({ asOf: req.query.asOf }));
});

router.get('/shipments-due', (req, res) => {
  res.json(dashboardService.listShipmentsDue({ onDate: req.query.onDate }));
});

router.get('/order-forecast', (req, res) => {
  res.json(dashboardService.forecastNextOrders());
});

module.exports = router;
