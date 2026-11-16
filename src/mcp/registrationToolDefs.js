// 蒸留以外の登録ツールの定義（入力の形とClaudeに見せる説明）。中身は registrationTools.js。
// **新しい記録の登録だけ。** 取消・修正・削除のツールはここに足さない（画面で行う）。

const { z, date, tankRef, preview, requestKey, READ, WRITE, WRITE_FLOW, wrap, ref } = require('./toolHelpers');
const t = require('./registrationTools');

const month = z.string().regex(/^\d{4}-\d{2}$/).describe('YYYY-MM');
const note = z.string().optional().describe('備考');
const writeFields = { preview, requestKey };

function registerRegistrationTools(server, ctx) {
  const write = (name, title, description, inputSchema, fn) =>
    server.registerTool(
      name,
      { title, description: `${description} ${WRITE_FLOW}`, inputSchema: { ...inputSchema, ...writeFields }, annotations: WRITE },
      wrap((args) => fn(args, ctx))
    );
  const read = (name, title, description, inputSchema, fn) =>
    server.registerTool(name, { title, description, inputSchema, annotations: READ }, wrap(fn));

  // --- 読み取り ---

  read('search_master', 'マスタを探す', '得意先・商品・資材・酒蔵・原酒銘柄を、名前やコードの一部で探す。', {
    type: z.enum(Object.keys(t.MASTER_TYPES)),
    query: z.string().optional().describe('名前・コードの一部。省くと先頭から'),
  }, t.searchMaster);

  read('find_orders', '受注を探す', '受注（明細ごと）を得意先・受注番号・状態で探す。取消済みは出さない。発送・委託報告の対象を探すのに使う。', {
    customer: ref('得意先').optional(),
    orderNo: z.string().optional().describe('受注番号の一部'),
    status: z.string().optional().describe('例「未着手」「発送済」'),
    salesMethod: z.enum(t.SALES_METHODS).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, t.findOrders);

  read('list_open_invoices', '入金待ちの請求', '残額がある請求（受注・委託販売の報告）。入金の消し込み先を探すのに使う。', {
    customer: ref('得意先').optional(),
  }, t.listOpenInvoices);

  read('list_wip_lots', '箱詰め待ちのロット', '瓶詰め済み・未箱詰めのロット（残り本数つき、古い順）。', {
    product: ref('商品').optional(),
  }, t.listWipLots);

  read('list_pending_consignments', '報告待ちの委託受注', 'まだ実績を報告しきっていない委託販売の受注。', {}, t.listPendingConsignments);

  read('get_registration_options', '登録の選択肢', '販売方法・納品方法・無償出荷の区分・未納税移出の搬出先・メモの種別・見積の状態・レシピの工程・容器種別・段ボールの資材。', {}, t.getRegistrationOptions);

  // --- 現場の作業 ---

  write('receive_raw_sake', '原酒入荷', '原酒を空の原酒タンクに受け入れる（複数タンク可）。', {
    txnDate: date.optional().describe('受入日（省くと今日）'),
    items: z.array(z.object({ tank: tankRef, quantityL: z.number().positive().describe('受入量 L') })).min(1),
    rawSakeBrand: ref('原酒銘柄').optional(),
    supplier: z.string().optional().describe('受入元（自由記述）'),
    specNote: z.string().optional().describe('規格'),
  }, t.receiveRawSake);

  write('record_bottling', '瓶詰め', '浄酎タンクから瓶詰めする（製品の仕掛品が増え、タンクが減り、瓶詰めの資材を使う）。', {
    product: ref('商品'),
    quantity: z.number().int().positive().describe('本数'),
    tank: tankRef.describe('払出元タンク（浄酎）'),
    volumeL: z.number().positive().describe('払出量 L'),
    abv: z.number().optional().describe('度数 %（省くとタンクの度数）'),
    txnDate: date.optional().describe('作業日（省くと今日）'),
    note,
  }, t.recordBottling);

  write('record_boxing', '箱詰め', '瓶詰め済みの仕掛品を箱詰めする（製品在庫が増え、箱詰めの資材を使う）。', {
    product: ref('商品'),
    quantity: z.number().int().positive().describe('本数'),
    lot: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe('瓶詰めロット（履歴コード）。省くと古い順'),
    txnDate: date.optional().describe('作業日（省くと今日）'),
    note,
  }, t.recordBoxing);

  write('transfer_tank', '容器移動', 'タンクからタンクへ液を移す。', {
    fromTank: tankRef.describe('移動元タンク'),
    toTank: tankRef.describe('移動先タンク'),
    quantityL: z.number().positive().describe('移動量 L'),
    abv: z.number().optional().describe('度数 %（省くと移動元の度数）'),
    txnDate: date.optional().describe('日付（省くと今日）'),
    note,
  }, t.transferTank);

  write('record_tax_free_transfer', '未納税移出', 'タンクから未納税で移出する。', {
    fromTank: tankRef.describe('払出元タンク'),
    quantityL: z.number().positive().describe('移出量 L'),
    destination: z.string().min(1).describe('搬出先（例「熟成室」）'),
    abv: z.number().optional().describe('度数 %（省くとタンクの度数）'),
    txnDate: date.optional().describe('日付（省くと今日）'),
    note,
  }, t.recordTaxFreeTransfer);

  write('receive_material', '資材入荷', '資材（瓶・ラベル・段ボールなど）の入荷を記録する。', {
    material: ref('資材'),
    quantity: z.number().positive().describe('入荷数'),
    unitPrice: z.number().nonnegative().optional().describe('単価（省くとマスタの単価）'),
    supplier: z.string().optional().describe('仕入先（省くとマスタの仕入先）'),
    txnDate: date.optional().describe('入荷日（省くと今日）'),
    note,
  }, t.receiveMaterial);

  // --- 受注・出荷 ---

  write('create_order', '受注登録', '受注を登録する。単価・売価は商品と得意先のマスタから決まる（画面と同じ）。', {
    orderedOn: date.describe('受注日'),
    customer: ref('得意先'),
    items: z.array(z.object({ product: ref('商品'), quantity: z.number().int().positive().describe('本数') })).min(1),
    shippingFee: z.number().nonnegative().optional().describe('送料（省くと0）'),
    salesMethod: z.enum(t.SALES_METHODS).optional().describe('省くと「買取」'),
    deliveryMethod: z.enum(t.DELIVERY_METHODS).optional().describe('省くと「配送」'),
    requestedDeliveryOn: date.optional().describe('納入希望日'),
    paymentDueOn: date.optional().describe('入金予定日（省くと支払いサイトから自動）'),
    invoicedOn: date.optional().describe('請求日'),
    deliveryAddress: z.string().optional().describe('納品先'),
    note,
  }, t.createOrder);

  write('ship_order', '発送済みにする', '受注（明細1行）を発送済みにし、出荷を記録する。段ボールを省くと対応表の推奨を使う（使っていなければ空の配列）。', {
    order: z.union([z.number().int().positive(), z.string().min(1)]).describe('受注番号、または明細のID'),
    lineNo: z.number().int().positive().optional().describe('明細の行番号（明細が複数のとき）'),
    product: ref('商品').optional().describe('明細が複数のとき、商品で選んでもよい'),
    deliveredOn: date.optional().describe('納品日（省くと今日）'),
    cartons: z.array(z.object({ material: ref('段ボール（資材）'), quantity: z.number().int().positive().describe('箱数') })).optional(),
    note,
  }, t.shipOrder);

  write('record_return', '返品', '製品の返品を記録する（製品在庫が戻る）。', {
    product: ref('商品'),
    quantity: z.number().int().positive().describe('返品数'),
    customer: ref('得意先').optional(),
    reason: z.string().optional().describe('理由'),
    txnDate: date.optional().describe('日付（省くと今日）'),
  }, t.recordReturn);

  write('record_sample', '無償出荷', 'サンプル・再発送・販促の無償出荷を記録する（製品在庫が減る）。', {
    product: ref('商品'),
    quantity: z.number().int().positive().describe('本数'),
    purpose: z.enum(['サンプル', '再発送', '販促']).optional().describe('省くと「サンプル」'),
    customer: ref('得意先').optional(),
    contactName: z.string().optional().describe('先方の担当者'),
    phone: z.string().optional(),
    shippedOn: date.optional().describe('送付日（省くと今日）'),
    followupOn: date.optional().describe('フォロー予定日'),
    note,
  }, t.recordSample);

  write('record_consignment_report', '委託販売の実績報告', '委託販売の受注について、月ごとの実売本数を報告する。', {
    order: z.union([z.number().int().positive(), z.string().min(1)]).describe('受注番号、または明細のID'),
    lineNo: z.number().int().positive().optional(),
    product: ref('商品').optional(),
    reportMonth: month.describe('対象月 YYYY-MM'),
    quantity: z.number().int().positive().describe('実売本数'),
    note,
  }, t.recordConsignmentReport);

  write('create_quotation', '見積', '見積を登録する。', {
    quotedOn: date.describe('見積日'),
    customer: ref('得意先'),
    product: ref('商品'),
    quantity: z.number().int().positive().describe('個数'),
    unitPrice: z.number().nonnegative().optional().describe('単価（省くと上代）'),
    markupRate: z.number().positive().optional().describe('掛率（省くと得意先の掛率）'),
    costPrice: z.number().nonnegative().optional().describe('原価'),
    probabilityPercent: z.number().min(0).max(100).optional().describe('確度 %'),
    deliveryDueOn: date.optional().describe('納期'),
    status: z.enum(['見積中', '受注', '失注']).optional().describe('省くと「見積中」'),
    note,
  }, t.createQuotation);

  // --- 入金 ---

  write('record_payment', '入金の記録', '入金を記録する。請求への割り当ては allocate_payment で行う。', {
    paidOn: date.optional().describe('入金日（省くと今日）'),
    amount: z.number().positive().describe('入金額（円）'),
    customer: ref('得意先').optional(),
    payerName: z.string().optional().describe('振込名義'),
    note,
  }, t.recordPayment);

  write('allocate_payment', '入金の消し込み', '入金を請求（受注番号か委託販売の報告番号）に1件割り当てる。既存の割り当ては変えない。', {
    payment: z.union([z.number().int().positive(), z.string().min(1)]).describe('入金番号（P…）、またはID'),
    orderNo: z.string().optional().describe('割り当て先の受注番号'),
    consignmentReport: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe('割り当て先の委託販売の報告番号（C…）'),
    amount: z.number().positive().describe('割り当てる金額（円）'),
    note,
  }, t.allocatePayment);

  // --- マスタ ---

  write('create_customer', '得意先の登録', '得意先を登録する。コードを省くと続き番号を付ける。', {
    name: z.string().min(1),
    code: z.string().optional(),
    parent: ref('本店').optional().describe('支店のときの本店'),
    segment: z.string().optional(),
    businessType: z.string().optional().describe('業態'),
    markupRate: z.number().positive().optional().describe('掛率'),
    address: z.string().optional(),
    paymentTermMonths: z.number().int().nonnegative().optional().describe('支払いサイト（月）'),
    paymentTermDay: z.string().optional().describe('支払日（例「末」「10」）'),
    invoiceDueNote: z.string().optional().describe('請求書の送付期日'),
    salesRep: z.string().optional().describe('担当者'),
    salesSubRep: z.string().optional().describe('副担当'),
    salesChannel: z.string().optional().describe('販路'),
    note,
  }, t.createCustomer);

  write('add_customer_note', '得意先の営業メモ', '得意先に営業メモを足す。', {
    customer: ref('得意先'),
    body: z.string().min(1).describe('内容'),
    category: z.enum(['メモ', '訪問', '電話', '課題']).optional().describe('省くと「メモ」'),
    notedOn: date.optional().describe('日付（省くと今日）'),
  }, t.addCustomerNote);

  write('create_product', '商品の登録', '商品を登録する。コードを省くと続き番号を付ける。レシピは add_recipe_row で足す。', {
    name: z.string().min(1),
    code: z.string().optional(),
    volumeMl: z.number().int().positive().optional().describe('容量 ml'),
    abv: z.number().optional().describe('度数 %'),
    containerType: z.string().optional().describe('容器'),
    unit: z.string().optional().describe('単位（省くと「本」）'),
    listPrice: z.number().nonnegative().optional().describe('上代'),
    janCode: z.string().optional(),
    category: z.string().optional(),
    taxCategory: z.string().optional().describe('酒類区分'),
    note,
  }, t.createProduct);

  write('add_recipe_row', 'レシピを1行足す', '商品の瓶詰め・箱詰めで使う資材を1行足す（同じ組み合わせが既にあれば断る）。', {
    product: ref('商品'),
    material: ref('資材'),
    process: z.enum(['瓶詰', '箱詰']),
    qtyRequired: z.number().positive().describe('1本あたりの必要数'),
    recipeCode: z.string().optional(),
  }, t.addRecipeRow);

  write('create_tank', 'タンクの登録', 'タンク（容器）を登録する。容器IDを省くと容器種別から採番する。', {
    name: z.string().min(1).describe('容器名称'),
    code: z.string().optional().describe('容器ID'),
    containerType: z.string().optional().describe('容器種別（例「ステンレスタンク」「原酒ポリタンク」「QBテナー」）'),
    isRawSakeTank: z.boolean().optional().describe('原酒を入れる容器か（省くと容器IDから判断）'),
    receivedYm: month.optional().describe('入荷年月（QBテナーなど入荷ごとに採番する容器）'),
    maxVolumeL: z.number().positive().optional(),
    location: z.string().optional(),
    status: z.string().optional().describe('省くと「稼働中」'),
    initialVolumeL: z.number().nonnegative().optional(),
    currentAbv: z.number().optional(),
    note,
  }, t.createTank);

  write('create_brewery', '酒蔵の登録', '酒蔵を登録する。コードを省くと続き番号を付ける。', {
    name: z.string().min(1),
    code: z.string().optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    contact: z.string().optional().describe('担当者'),
    startedOn: date.optional().describe('取引開始日'),
  }, t.createBrewery);

  write('create_raw_sake_brand', '原酒銘柄の登録', '原酒銘柄を登録する。酒蔵はマスタから選び、無い名前はそのまま残す。', {
    name: z.string().min(1),
    code: z.string().optional().describe('原酒ID'),
    brewery: ref('酒蔵').optional(),
    abv: z.number().optional(),
    sakeMeterValue: z.number().optional().describe('日本酒度'),
    status: z.string().optional(),
    producedOn: z.string().optional().describe('製造時期（自由記述）'),
    registeredOn: date.optional(),
    note,
  }, t.createRawSakeBrand);

  write('create_material', '資材の登録', '資材を登録する。コードを省くと続き番号を付ける。', {
    name: z.string().min(1),
    code: z.string().optional(),
    category: z.string().optional().describe('分類（段ボールは「外箱」）'),
    unit: z.string().optional(),
    unitPrice: z.number().nonnegative().optional(),
    lotSize: z.number().int().positive().optional(),
    properStockQty: z.number().nonnegative().optional().describe('適正在庫'),
    supplierName: z.string().optional(),
    supplierAddress: z.string().optional(),
    supplierContact: z.string().optional(),
    leadTimeDays: z.number().int().nonnegative().optional(),
    note,
  }, t.createMaterial);
}

module.exports = { registerRegistrationTools };
