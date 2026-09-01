// 排他制御（蒸留の同時編集防止）

const express = require('express');
const lockService = require('../services/lockService');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(lockService.list());
});

router.post('/distillations/:id', (req, res, next) => {
  try {
    res.status(201).json(
      lockService.acquire({ distillationId: Number(req.params.id), user: req.user })
    );
  } catch (err) {
    next(err);
  }
});

router.delete('/distillations/:id', (req, res, next) => {
  try {
    const released = lockService.release({
      distillationId: Number(req.params.id),
      user: req.user,
    });
    res.json({ released });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
