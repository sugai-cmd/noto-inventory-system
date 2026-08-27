/**
 * 業務ルール違反を表すエラー（在庫不足、二重発送 等）。
 * サーバー障害ではなく利用者の操作起因なので、errorHandlerで4xxに変換する。
 */
class BusinessRuleError extends Error {
  constructor(message, { status = 422, code = 'business_rule_violation' } = {}) {
    super(message);
    this.name = 'BusinessRuleError';
    this.status = status;
    this.code = code;
  }
}

/** 対象が存在しない場合（404） */
class NotFoundError extends BusinessRuleError {
  constructor(message) {
    super(message, { status: 404, code: 'not_found' });
    this.name = 'NotFoundError';
  }
}

/** 既に処理済みなど、現在の状態と競合する場合（409） */
class ConflictError extends BusinessRuleError {
  constructor(message) {
    super(message, { status: 409, code: 'conflict' });
    this.name = 'ConflictError';
  }
}

module.exports = { BusinessRuleError, NotFoundError, ConflictError };
