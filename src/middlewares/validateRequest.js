// zodスキーマでリクエストボディを検証するミドルウェア。
// 失敗時は400を返し、成功時は検証・変換済みの値で req.body を置き換える。

function validateRequest(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'validation_error',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateRequest };
