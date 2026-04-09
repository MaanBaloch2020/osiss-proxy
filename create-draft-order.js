// ================================================================
//  OSISS™ — Shopify Draft Order Proxy
//  FILE: api/create-draft-order.js
//
//  WHAT IT DOES:
//    Browser → POST /api/create-draft-order
//    Proxy   → POST https://{store}.myshopify.com/admin/api/.../draft_orders.json
//    Returns → { id, name, invoice_url, status }
//
//  WHY A PROXY IS REQUIRED:
//    The Shopify Admin API needs a secret access token. That token
//    must NEVER live in the browser (anyone can read osiss.js).
//    This serverless function holds the token server-side.
//
//  ── VERCEL SETUP (recommended) ──────────────────────────────────
//    1. Push this file to:  /api/create-draft-order.js
//       (Vercel auto-detects /api/*.js as serverless functions)
//    2. In Vercel dashboard → Project → Settings → Environment Variables:
//         SHOPIFY_STORE_DOMAIN  =  osiss-7178.myshopify.com
//         SHOPIFY_ADMIN_TOKEN   =  shpat_xxxxxxxxxxxxxxxxxxxx
//         ALLOWED_ORIGIN        =  https://www.osiss.com.pk
//    3. In your Shopify theme.liquid, add before osiss.js:
//         <script>
//           window.OSISS_CONFIG = {
//             waNumber: "{{ settings.whatsapp_number | default: '923021345111' }}",
//             draftOrderProxy: "https://your-vercel-app.vercel.app/api/create-draft-order"
//           };
//         </script>
//
//  ── NETLIFY SETUP (alternative) ─────────────────────────────────
//    1. Move this file to: /netlify/functions/create-draft-order.js
//    2. Change the export at the bottom to Netlify format:
//         exports.handler = async function(event) {
//           const req = { method: event.httpMethod, body: JSON.parse(event.body || '{}') };
//           const results = [];
//           const res = {
//             status: (c) => ({ json: (d) => results.push({ statusCode: c, body: JSON.stringify(d) }) }),
//             setHeader: () => {}
//           };
//           await handler(req, res);
//           return results[0];
//         };
//    3. Set environment variables in Netlify dashboard.
//    4. URL will be: https://your-app.netlify.app/.netlify/functions/create-draft-order
//
//  ── HOW TO GET YOUR ADMIN TOKEN ─────────────────────────────────
//    Shopify Admin → Settings → Apps and sales channels →
//    Develop Apps → Create an App → Admin API access scopes:
//      ✅ write_draft_orders
//      ✅ read_draft_orders
//    → Install App → Copy "Admin API access token" (shpat_...)
// ================================================================

const SHOPIFY_API_VERSION = '2024-01';

// ── Helper: normalize Pakistani number to E.164 (+923xxxxxxxxx) ──
function normalizePhone(raw) {
  var digits = (raw || '').replace(/\D/g, '');
  // "03001234567" → "923001234567"
  if (digits.startsWith('0') && digits.length === 11) {
    digits = '92' + digits.slice(1);
  }
  // "923001234567" → "+923001234567"
  return digits.startsWith('+') ? digits : '+' + digits;
}

// ── Helper: build CORS headers ──
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── Main handler ────────────────────────────────────────────────
async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const cors = corsHeaders(ALLOWED_ORIGIN);

  // Set CORS on every response
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ── Environment variables ──
  const STORE = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!STORE || !TOKEN) {
    console.error('[OSISS Draft Order] Missing env vars: SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN');
    return res.status(500).json({ error: 'Server configuration error. Contact store admin.' });
  }

  // ── Parse body ──
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  const {
    customer,
    shippingAddress,
    lineItems,
    discount        = 0,
    advanceDiscount = 0,
    shippingFee     = 0,
    shippingTitle   = 'Delivery',
    grandTotal      = 0,
    paymentMethod   = '',
    transactionId   = '',
    deliveryType    = 'economy',
    customOrderId   = '',
    note            = ''
  } = payload || {};

  // ── Validation ──
  if (!customer?.email) {
    return res.status(400).json({ error: 'Missing required field: customer.email' });
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return res.status(400).json({ error: 'Missing required field: lineItems (array)' });
  }

  // ── Build Shopify line items ──
  // Filter to items that have a valid numeric Shopify variant_id.
  // Items without a numeric ID (e.g. legacy PRODUCTS array items) are
  // sent as custom line items with title + price so they still appear.
  const shopifyLineItems = lineItems.map(function(item) {
    var vid = parseInt(item.variantId);
    if (vid && vid > 0) {
      // Standard Shopify variant → let Shopify use the live price
      return {
        variant_id: vid,
        quantity:   item.quantity || 1,
        title:      item.name || undefined
      };
    } else {
      // Custom / non-Shopify item → manual line item with price
      return {
        title:    item.name || 'Custom Product',
        quantity: item.quantity || 1,
        price:    String(item.price || 0),
        requires_shipping: true
      };
    }
  });

  // ── Build order-level discount (promo + advance discount combined) ──
  const totalDiscount = (Number(discount) || 0) + (Number(advanceDiscount) || 0);
  const appliedDiscount = totalDiscount > 0 ? {
    description: [
      discount > 0        ? 'Promo Discount'    : null,
      advanceDiscount > 0 ? 'Advance Discount'  : null
    ].filter(Boolean).join(' + '),
    value_type: 'fixed_amount',
    value:      String(totalDiscount),
    amount:     String(totalDiscount),
    title:      'OSISS™ Discount'
  } : null;

  // ── Build shipping line ──
  const shippingLine = {
    title:  shippingTitle,
    price:  String(Number(shippingFee) || 0),
    custom: true
  };

  // ── Note attributes (visible in Shopify Admin → Orders → Timeline) ──
  const noteAttributes = [
    { name: 'Custom Order ID',  value: customOrderId  || '' },
    { name: 'Payment Method',   value: paymentMethod  || '' },
    { name: 'Delivery Type',    value: deliveryType   || '' },
    { name: 'Phone',            value: normalizePhone(customer.phone) },
    { name: 'Grand Total PKR',  value: String(grandTotal) },
  ];
  if (transactionId) {
    noteAttributes.push({ name: 'Transaction ID', value: transactionId });
  }

  // ── Tags ──
  const tagDelivery = deliveryType === 'express' ? 'express-delivery' : 'economy-delivery';
  const tagPayment  = (paymentMethod || 'cod')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const tags = ['custom-checkout', tagDelivery, tagPayment].join(', ');

  // ── Full Draft Order payload ──
  const draftOrderPayload = {
    draft_order: {
      line_items: shopifyLineItems,

      customer: {
        first_name: customer.firstName || '',
        last_name:  customer.lastName  || '',
        email:      customer.email,
        phone:      normalizePhone(customer.phone)
      },

      shipping_address: {
        first_name: shippingAddress?.firstName || customer.firstName || '',
        last_name:  shippingAddress?.lastName  || customer.lastName  || '',
        address1:   shippingAddress?.address1  || '',
        address2:   shippingAddress?.address2  || '',
        city:       shippingAddress?.city      || '',
        province:   shippingAddress?.province  || '',
        country:    shippingAddress?.country   || 'PK',
        zip:        shippingAddress?.zip       || '',
        phone:      normalizePhone(customer.phone)
      },

      // Order-level discount (only included if > 0)
      ...(appliedDiscount && { applied_discount: appliedDiscount }),

      // Shipping line
      shipping_line: shippingLine,

      note:            note || '',
      note_attributes: noteAttributes,
      tags:            tags,

      // Don't auto-send invoice email to customer
      send_invoice: false,

      // Set to 'open' so it appears in Admin → Orders → Drafts immediately
      status: 'open'
    }
  };

  // ── Call Shopify Admin API ──
  const apiURL = `https://${STORE}/admin/api/${SHOPIFY_API_VERSION}/draft_orders.json`;

  let shopifyRes;
  try {
    shopifyRes = await fetch(apiURL, {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': TOKEN,
        'Accept':                 'application/json'
      },
      body: JSON.stringify(draftOrderPayload)
    });
  } catch (networkErr) {
    console.error('[OSISS Draft Order] Network error calling Shopify:', networkErr.message);
    return res.status(502).json({ error: 'Could not reach Shopify. Please try again or contact support.' });
  }

  // ── Handle Shopify response ──
  let shopifyData;
  try {
    shopifyData = await shopifyRes.json();
  } catch (parseErr) {
    return res.status(502).json({ error: 'Invalid response from Shopify API.' });
  }

  if (!shopifyRes.ok) {
    console.error('[OSISS Draft Order] Shopify API error:', JSON.stringify(shopifyData));
    const errMsg = shopifyData?.errors
      ? (typeof shopifyData.errors === 'string'
          ? shopifyData.errors
          : JSON.stringify(shopifyData.errors))
      : `Shopify returned HTTP ${shopifyRes.status}`;
    return res.status(shopifyRes.status).json({ error: errMsg });
  }

  // ── Success ──
  const created = shopifyData.draft_order;
  console.log(`[OSISS Draft Order] Created: ${created.name} (ID: ${created.id}) | Customer: ${customer.email} | Total: ${created.total_price}`);

  return res.status(200).json({
    id:          created.id,
    name:        created.name,          // e.g. "#D1001" — show this to customer
    invoice_url: created.invoice_url,   // Shopify-hosted invoice page
    status:      created.status,
    total_price: created.total_price,
    order_number: created.order_number
  });
}

// ── Vercel export ────────────────────────────────────────────────
module.exports = handler;
// For Vercel with ES modules, replace the above line with:
// export default handler;
