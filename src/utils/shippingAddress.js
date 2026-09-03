// 配送先欄（住所・氏名・電話が1セルに混在）の分解。
//
// GAS版 CsvExportCode.gs の parseShippingAddress_ を、判定順も含めてそのまま移した。
// ゆうパックCSVは郵便番号・都道府県・市区町村郡が別々の列なので、この分解が要る。
//
// 運用ルール（GAS版READMEと同じ）：
//   丁目番地号／氏名／電話番号の境目にスペースまたは改行を入れて入力する。

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

/**
 * @param {string} raw - 受注の配送先欄
 * @returns {{zip,prefecture,city,address,building,name,phone,unresolved:boolean}}
 */
function parseShippingAddress(raw) {
  const result = {
    zip: '', prefecture: '', city: '', address: '',
    building: '', name: '', phone: '', unresolved: false,
  };
  if (!raw) {
    result.unresolved = true;
    return result;
  }

  let text = String(raw).replace(/\r/g, '\n');

  // 「お名前：」等のラベル形式に対応（ラベルを区切りスペースに置換）
  text = text.replace(
    /(お名前|氏名|名前|郵便番号|住所|電話番号|TEL|Tel|tel|お届け日|お届け時間|配送先)\s*[：:]/g,
    ' '
  );

  // 「お届け日：2026/06/18」「14時～16時」などの配送指定情報を除去
  text = text.replace(/\d{4}\/\d{1,2}\/\d{1,2}/g, ' ');
  text = text.replace(/\d{1,2}\s*時\s*[～~-]\s*\d{1,2}\s*時/g, ' ');
  text = text.replace(/指定なし/g, ' ');

  // 郵便番号（〒123-4567 または 1234567）
  const zipMatch = text.match(/〒?\s*(\d{3})[-－ー]?(\d{4})/);
  if (zipMatch) {
    result.zip = zipMatch[1] + zipMatch[2];
    text = text.replace(zipMatch[0], ' ');
  }

  // 電話番号（ハイフンあり／なし、10〜11桁）
  const phoneMatch = text.match(/(0\d{1,4}[-－ー]?\d{1,4}[-－ー]?\d{3,4})/);
  if (phoneMatch) {
    result.phone = phoneMatch[1].replace(/[－ー]/g, '-');
    text = text.replace(phoneMatch[0], ' ');
  }

  // 氏名（「〜様」「〜御中」「〜殿」で終わる箇所）を先に取る。
  // 行・スペース区切りのトークン単位で見て、住所の一部を誤検出しないようにする。
  {
    const tokens = text.split(/[\s　\n]+/).filter((t) => t !== '');
    const hitIdx = tokens.findIndex((t) => /(様|殿|御中)$/.test(t));
    if (hitIdx !== -1) {
      let candidate = tokens[hitIdx].replace(/(様|殿|御中)$/, '');
      let startIdx = hitIdx;
      // 「岩崎 奨 様」のように姓と名がスペースで分かれているケースを結合する
      if (candidate === '' && hitIdx > 0) {
        candidate = tokens[hitIdx - 1];
        startIdx = hitIdx - 1;
      }
      if (startIdx > 0) {
        const prev = tokens[startIdx - 1];
        const prevIsNameLike =
          /^[一-龥ぁ-んァ-ヶー]{1,5}$/.test(prev) &&
          !PREFECTURES.some((p) => prev.includes(p)) &&
          !/(市|区|町|村|郡|県|府|都|道|丁目|番地|号)$/.test(prev);
        if (prevIsNameLike) {
          candidate = prev + candidate;
          startIdx -= 1;
        }
      }
      const looksLikeAddress =
        PREFECTURES.some((p) => candidate.includes(p)) || /\d/.test(candidate);
      if (candidate !== '' && !looksLikeAddress) {
        result.name = candidate;
        tokens.splice(startIdx, hitIdx - startIdx + 1);
        text = tokens.join(' ');
      }
    }
  }

  // 都道府県
  const pref = PREFECTURES.find((p) => text.includes(p));
  if (pref) {
    result.prefecture = pref;
    const idx = text.indexOf(pref);
    text = `${text.substring(0, idx)} ${text.substring(idx + pref.length)}`;
  }

  // 残りを市区町村郡・丁目番地号・建物名に割り当て
  const rest = text.split(/[\s　\n]+/).filter((t) => t !== '');
  if (rest.length > 0) result.city = rest[0];
  if (rest.length > 1) result.address = rest[1];
  if (rest.length > 2) result.building = rest.slice(2).join(' ');

  // ゆうパックCSVでは郵便番号と市区町村郡が必須なので、揃わなければ要手修正
  if (!result.zip || !result.city || !result.prefecture) result.unresolved = true;
  // 市区町村郡が明らかに住所らしくない（極端に短い）場合も要確認
  if (result.city && result.city.length <= 2) result.unresolved = true;

  return result;
}

module.exports = { parseShippingAddress, PREFECTURES };
