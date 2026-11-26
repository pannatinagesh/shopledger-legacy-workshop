const assert = require('node:assert/strict');
const test = require('node:test');
const app = require('../server');
const orderRoutes = require('../routes/orders');
const reportRoutes = require('../routes/reports');
const store = require('../lib/store');
const pricing = require('../lib/pricing');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');

function callRoute(router, method, path, req = {}) {
  const layer = router.stack.find(({ route }) => route?.path === path && route.methods[method]);
  assert.ok(layer, method + ' ' + path + ' is registered');
  const response = { status: 200 };
  layer.route.dispatch({ method: method.toUpperCase(), ...req }, {
    status(code) {
      response.status = code;
      return this;
    },
    json(body) {
      response.body = JSON.parse(JSON.stringify(body));
    },
    send(body) {
      response.body = body;
    }
  }, (error) => {
    throw error || new Error('Route did not send a response');
  });
  return response;
}

test('historical order #1004 prints the capped discount and 5% GST it was billed', () => {
  const order = {
    id: 1004,
    date: '30/01/2022',
    items: [{ name: 'Cold-Pressed Groundnut Oil 5L', hsn: '1508', price: 1120, qty: 2 }],
    coupon: 'SAVE10',
    discount: 150,
    tax: 104.5,
    total: 2194.5
  };

  const printed = invoice.computeInvoiceFigures(order);
  assert.deepEqual(
    [printed.discount, printed.tax, printed.total],
    [order.discount, order.tax, order.total]
  );
  assert.equal(printed.rows[0].gstPercent, 5);
});

test('saved invoices keep the applied discount when current coupon rules differ', () => {
  const items = [{ name: 'Tea', price: 1000, qty: 1 }];
  const orders = [
    { id: 1, items, coupon: 'DIWALI20', subtotal: 1000, discount: 200, tax: 144, total: 944 },
    { id: 2, items, coupon: 'SAVE10', subtotal: 1000, discount: 0, tax: 180, total: 1180 }
  ];

  for (const order of orders) {
    assert.notEqual(pricing.computeTotals(items, order.coupon).discount, order.discount);
    const printed = invoice.computeInvoiceFigures(order);
    assert.deepEqual(
      [printed.discount, printed.tax, printed.total],
      [order.discount, order.tax, order.total]
    );
  }
  assert.equal(reports.getGstReconciliation({ orders }).mismatchCount, 0);
});

test('the mixed-HSN coupon invoice matches the preview, saved order and Khata debit', (t) => {
  const db = {
    products: [
      { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 150, stock: 10 },
      { id: 2, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 200, stock: 10 }
    ],
    customers: [{ id: 1, name: 'Retail Customer', totalBilled: 0 }],
    orders: [],
    nextOrderId: 1001
  };
  t.mock.method(store, 'read', () => db);
  t.mock.method(store, 'write', (saved) => assert.equal(saved, db));

  const cart = {
    items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }],
    coupon: ' save10 ',
    paymentMode: 'khata',
    customerId: 1
  };

  const preview = callRoute(reportRoutes, 'post', '/pricing/preview', { body: cart });
  assert.equal(preview.status, 200);
  const { totals, couponStatus } = preview.body;
  assert.equal(couponStatus.code, 'SAVE10');
  assert.deepEqual(totals, {
    subtotal: 500, discount: 50, taxable: 450, tax: 35.1,
    cgst: 17.55, sgst: 17.55, total: 485.1,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 300, discount: 30, taxable: 270, tax: 13.5, net: 283.5 },
      { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 200, discount: 20, taxable: 180, tax: 21.6, net: 201.6 }
    ]
  });

  const created = callRoute(orderRoutes, 'post', '/orders', { body: cart });
  assert.equal(created.status, 201);
  const order = created.body;
  assert.deepEqual(order, db.orders[0]);
  assert.deepEqual(
    [order.coupon, order.subtotal, order.discount, order.tax, order.total],
    ['SAVE10', 500, 50, 35.1, 485.1]
  );
  assert.deepEqual(db.products.map((product) => product.stock), [8, 9]);
  assert.equal(db.customers[0].balance, 485.1);
  assert.equal(db.customers[0].totalBilled, 485.1);

  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, { subtotal: 500, discount: 50, tax: 35.1, cgst: 17.55, sgst: 17.55, total: 485.1 });
  assert.deepEqual(rows.map((row) => [row.hsn, row.gstPercent, row.lineTax]), [
    ['1006', 5, 13.5], ['0405', 12, 21.6]
  ]);

  const printed = callRoute(app._router, 'get', '/orders/:id/invoice', { params: { id: '1001' } });
  assert.equal(printed.status, 200);
  const html = printed.body;
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹35\.10/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹485\.10/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  const reconciliation = callRoute(reportRoutes, 'get', '/reports/gst-reconciliation');
  assert.equal(reconciliation.status, 200);
  assert.deepEqual(reconciliation.body, {
    totalChecked: 1, mismatchCount: 0, totalDelta: 0,
    rows: [{
      orderId: 1001, date: order.date, customer: 'Retail Customer', coupon: 'SAVE10',
      ledgerSubtotal: 500, ledgerDiscount: 50, ledgerTax: 35.1, ledgerTotal: 485.1,
      invoiceDiscount: 50, invoiceTax: 35.1, invoiceTotal: 485.1, delta: 0, matched: true
    }]
  });

  const cancelled = callRoute(orderRoutes, 'post', '/orders/:id/cancel', {
    params: { id: '1001' },
    body: { reason: 'Customer cancelled' }
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  // Cancellation leaves physical stock at the post-sale quantities.
  assert.deepEqual(db.products.map((product) => product.stock), [8, 9]);
  assert.equal(db.customers[0].balance, 0);
  assert.equal(db.customers[0].totalBilled, 0);
  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 0, mismatchCount: 0, totalDelta: 0, rows: []
  });
});

test('checkout and invoice agree for a whole-percent GST rate without a coupon', () => {
  const items = [{ name: 'Ghee', price: 100, qty: 2, gstRate: 12 }];
  const checkout = pricing.computeTotals(items, '');
  const printed = invoice.computeInvoiceFigures({ items });
  assert.deepEqual([checkout.tax, checkout.total], [24, 224]);
  assert.deepEqual([printed.tax, printed.total], [24, 224]);
  assert.doesNotMatch(invoice.render({ items, total: 224 }), /Accountant Reconciliation Notice/);
});

test('checkout and invoice agree on decimal and zero GST rates', () => {
  const items = [
    { name: 'Ghee', price: 100, qty: 1, gstRate: 0.12 },
    { name: 'Zero-rated item', price: 100, qty: 1, gstRate: 0 }
  ];
  const checkout = pricing.computeTotals(items, '');
  const printed = invoice.computeInvoiceFigures({ items });
  assert.deepEqual(checkout.lines.map((line) => [line.gstPercent, line.tax]), [[12, 12], [0, 0]]);
  assert.deepEqual(printed.rows.map((row) => [row.gstPercent, row.lineTax]), [[12, 12], [0, 0]]);
  assert.equal(checkout.total, 212);
  assert.equal(printed.total, 212);
});

for (const [coupon, price, discount] of [
  ['SAVE10', 2000, 150],
  ['FLAT50', 100, 0],
  ['DIWALI20', 1000, 0],
  [' welcome ', 100, 5]
]) {
  test('checkout and invoice apply the same coupon rules for ' + JSON.stringify(coupon), () => {
    const items = [{ name: 'Tea', price, qty: 1 }];
    assert.equal(pricing.computeTotals(items, coupon).discount, discount);
    assert.equal(invoice.computeInvoiceFigures({ items, coupon }).discount, discount);
  });
}

test('invoice total GST is the sum of the rounded line GST shown on the invoice', () => {
  const items = [
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ];
  const checkout = pricing.computeTotals(items, '');
  const printed = invoice.computeInvoiceFigures({ items });
  assert.deepEqual(printed.rows.map((row) => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([checkout.tax, checkout.cgst, checkout.sgst, checkout.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual([printed.tax, printed.cgst, printed.sgst, printed.total], [0.02, 0.01, 0.01, 0.08]);
  assert.doesNotMatch(invoice.render({ items, total: 0.08 }), /Accountant Reconciliation Notice/);
});

test('CURRENT BEHAVIOUR: reconciliation flags a tax-only mismatch while the invoice shows no notice', () => {
  const order = {
    id: 1001, date: '15/07/2021', subtotal: 100, discount: 0, tax: 17.99, total: 118,
    items: [{ name: 'Tea', price: 100, qty: 1 }]
  };
  const result = reports.getGstReconciliation({ orders: [order] });
  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.rows[0].invoiceTax, 18);
  assert.equal(result.rows[0].delta, 0);
  assert.equal(result.rows[0].matched, false);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
