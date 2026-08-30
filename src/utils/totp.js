// 2要素認証（TOTP: RFC 6238）。
// Google Authenticator / Microsoft Authenticator / 1Password などが対応している標準方式。
// Node.js標準のcryptoだけで実装できるため、外部ライブラリは使わない。

const crypto = require('node:crypto');

const STEP_SECONDS = 30; // コードが切り替わる間隔
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 認証アプリが読める形式（Base32）に変換する */
function toBase32(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('不正なBase32文字が含まれています');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新しい秘密鍵を作る（160bit = TOTPの推奨値） */
function generateSecret() {
  return toBase32(crypto.randomBytes(20));
}

/**
 * ある時刻のコードを計算する。
 * @param {string} secret - Base32の秘密鍵
 * @param {number} counter - 時刻を30秒単位に丸めたもの
 */
function generateCode(secret, counter) {
  const key = fromBase32(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  // RFC 4226 の動的切り出し
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * 入力されたコードを検証する。
 * 端末の時計が多少ずれていても通るよう、前後1ステップ（±30秒）まで許容する。
 */
function verifyCode(secret, code, { window = 1, now = Date.now() } = {}) {
  const input = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(input)) return false;

  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let offset = -window; offset <= window; offset++) {
    const expected = generateCode(secret, counter + offset);
    // 比較時間から情報が漏れないようにする
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input))) return true;
  }
  return false;
}

/**
 * 認証アプリに読み込ませるURI。QRコードの中身になる。
 */
function buildOtpAuthUri({ secret, username, issuer = 'NOTO Naorai' }) {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/** 認証器を無くしたとき用の使い捨てコード */
function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2')
  );
}

module.exports = {
  generateSecret,
  generateCode,
  verifyCode,
  buildOtpAuthUri,
  generateRecoveryCodes,
  STEP_SECONDS,
};
