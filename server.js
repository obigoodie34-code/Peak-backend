const express    = require("express");
const crypto     = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── CONFIG (set these as environment variables on Railway) ── */
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET_KEY;   // your Paystack secret key
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_SERVICE  = process.env.SUPABASE_SERVICE_KEY;  // service role key (not anon)
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;     // your Anthropic API key
const ALLOWED_ORIGIN    = "*"; // allow all origins

/* ── SUPABASE CLIENT (service role — can write anything) ── */
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);

/* ── RATE LIMITER (in-memory, resets on server restart) ── */
const rateLimits = new Map(); // ip -> { count, resetAt }

function rateLimit(ip, maxPerWindow = 3, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxPerWindow - 1 };
  }

  if (entry.count >= maxPerWindow) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count++;
  return { allowed: true, remaining: maxPerWindow - entry.count };
}

/* Clean up old entries every 5 mins */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits.entries()) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

/* ── MIDDLEWARE ── */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* Raw body for Paystack webhook signature verification */
app.use("/webhook/paystack", express.raw({ type: "*/*" }));

/* JSON body for all other routes */
app.use((req, res, next) => {
  if (req.path === "/webhook/paystack") return next();
  express.json()(req, res, next);
});

/* ── HEALTH CHECK ── */
app.get("/", (req, res) => {
  res.json({ status: "Peak Supplies backend running", time: new Date().toISOString() });
});

/* ════════════════════════════════════════
   PAYSTACK WEBHOOK
   Paystack calls this URL when payment is confirmed.
   Set this URL in: dashboard.paystack.com → Settings → API → Webhooks
   URL: https://your-railway-app.railway.app/webhook/paystack
════════════════════════════════════════ */
app.post("/webhook/paystack", async (req, res) => {
  try {
    /* 1. Verify the request actually came from Paystack */
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(req.body)
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      console.warn("Invalid Paystack webhook signature");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());
    console.log("Paystack webhook event:", event.event, event.data?.reference);

    /* 2. Only handle successful charge events */
    if (event.event !== "charge.success") {
      return res.sendStatus(200); // acknowledge but ignore other events
    }

    const data = event.data;
    const paystackRef = data.reference; // format: "CHG-PSO-XXXXXX"

    /* 3. Extract our order ref from Paystack reference */
    // Our refs are formatted as "CHG-PSO-XXXXXX"
    const orderRef = paystackRef.replace(/^CHG-/, ""); // → "PSO-XXXXXX"
    const amountNGN = data.amount / 100; // Paystack sends in kobo

    console.log(`Payment confirmed: ${orderRef} — ₦${amountNGN.toLocaleString()}`);

    /* 4. Update order in Supabase */
    const { error } = await sb
      .from("orders")
      .update({
        status:     "paid",
        total:      amountNGN,
        updated_at: new Date().toISOString(),
      })
      .eq("ref", orderRef);

    if (error) {
      console.error("Supabase update error:", error);
      return res.sendStatus(500);
    }

    /* 5. Log the payment in payments table */
    await sb.from("payments").insert({
      id:         `PAY-${Date.now()}`,
      date:       new Date().toLocaleDateString("en-GB"),
      item:       `Client payment — Order ${orderRef}`,
      amount_ngn: amountNGN,
      amount_usd: 0,
      method:     "Paystack (client)",
    }).select();

    console.log(`✅ Order ${orderRef} marked as paid in Supabase`);

    // Get order details to send confirmation email
    const { data: orderData } = await sb.from("orders").select("*").eq("ref", orderRef).single();
    if(orderData){
      const shipping = orderData.shipping || "Standard";
      const deliveryDays = shipping.includes("Express") ? "5-8" : shipping.includes("Exclusive") ? "3-5" : "10-15";
      
      // Send payment confirmed + delivery estimate email to client
      try{
        await fetch("https://formspree.io/f/xreyjqyq",{
          method:"POST",
          headers:{"Content-Type":"application/json","Accept":"application/json"},
          body:JSON.stringify({
            _subject:`✅ Payment Confirmed — Order ${orderRef} — Delivery in ${deliveryDays} Business Days`,
            to: orderData.email,
            customer_name: orderData.name,
            reference: orderRef,
            message: `Hi ${orderData.name},\n\n✅ PAYMENT CONFIRMED\n\nYour payment of ₦${amountNGN.toLocaleString()} for order ${orderRef} has been received and confirmed.\n\nITEMS: ${orderData.items}\n\n━━━━━━━━━━━━━━━━━━━\nORDER APPROVED ✅\nEstimated Delivery: ${deliveryDays} business days\n━━━━━━━━━━━━━━━━━━━\n\nWe are now processing your order. You will receive a tracking number once your item has been shipped.\n\nTrack your order at any time using reference: ${orderRef}\n\nThank you for choosing Peak Supplies.`
          })
        });
      }catch(emailErr){ console.warn("Confirmation email error:", emailErr); }
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
});

/* ════════════════════════════════════════
   AI PROXY WITH RATE LIMITING
   Your HTML calls this instead of Anthropic directly.
   This keeps your API key secure on the server.
════════════════════════════════════════ */
app.post("/api/ai", async (req, res) => {
  /* Get real IP (works behind proxies/Railway) */
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
           || req.socket.remoteAddress
           || "unknown";

  /* Check rate limit — 3 AI calls per minute per IP */
  const limit = rateLimit(ip, 3, 60 * 1000);

  if (!limit.allowed) {
    return res.status(429).json({
      error: "Too many requests. Please wait before searching again.",
      retryAfter: limit.retryAfter,
    });
  }

  res.setHeader("X-RateLimit-Remaining", limit.remaining);

  /* Forward request to Anthropic */
  try {
    const { prompt, maxTokens = 1200 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        tools:      [{ type: "web_search_20250305", name: "web_search" }],
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anthropic error:", err);
      return res.status(response.status).json({ error: "AI service error" });
    }

    const data = await response.json();
    return res.json(data);

  } catch (err) {
    console.error("AI proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ════════════════════════════════════════
   VERIFY PAYMENT (client can check if payment went through)
   Called from the tracking page
════════════════════════════════════════ */
app.get("/api/order/:ref", async (req, res) => {
  const ip    = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const limit = rateLimit(ip, 10, 60 * 1000); // 10 lookups per minute
  if (!limit.allowed) return res.status(429).json({ error: "Too many requests" });

  try {
    const { data, error } = await sb
      .from("orders")
      .select("ref,name,status,shipping,tracking_num,carrier,local_carrier,local_track_num,local_est_date,date")
      .eq("ref", req.params.ref.toUpperCase())
      .single();

    if (error || !data) return res.status(404).json({ error: "Order not found" });

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});


/* ════════════════════════════════════════
   CREATE PAYSTACK PAYMENT LINK
   Called after AI finishes analysing an order.
   Generates a real Paystack payment URL and emails it to the client.
════════════════════════════════════════ */
app.post("/api/payment-link", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const limit = rateLimit(ip, 10, 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: "Too many requests" });

  try {
    const { orderRef, email, name, amount, items, shipping, sourcingCost, profit } = req.body;

    if (!orderRef || !email || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 1. Create Paystack payment link
    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PAYSTACK_SECRET}`,
      },
      body: JSON.stringify({
        email,
        amount: Math.round(amount * 100), // convert to kobo
        reference: "CHG-" + orderRef,
        currency: "NGN",
        metadata: {
          custom_fields: [
            { display_name: "Order Reference", variable_name: "order_ref", value: orderRef },
            { display_name: "Items", variable_name: "items", value: items },
          ]
        },
        callback_url: process.env.ALLOWED_ORIGIN || "https://obigoodie34-code.github.io/Peaksupplies-/",
      }),
    });

    const paystackData = await paystackRes.json();

    if (!paystackData.status) {
      console.error("Paystack error:", paystackData);
      return res.status(500).json({ error: "Could not create payment link" });
    }

    const paymentUrl = paystackData.data.authorization_url;

    // 2. Save payment URL to Supabase
    await sb.from("orders").update({
      payment_url: paymentUrl,
      ai_recommended_charge: amount,
      updated_at: new Date().toISOString(),
    }).eq("ref", orderRef);

    // 3. Send email to client via Formspree
    const formspreeEndpoint = process.env.FORMSPREE_ENDPOINT || "https://formspree.io/f/xreyjqyq";
    
    const emailBody = `Hi ${name},

Your order from Peak Supplies is ready for payment.

ORDER REFERENCE: ${orderRef}
ITEMS: ${items}

TOTAL TO PAY: ₦${amount?.toLocaleString()}

Click below to pay securely via Paystack:
${paymentUrl}

Your order will be processed immediately after payment is confirmed.
Track your order using reference: ${orderRef}

Thank you for choosing Peak Supplies.
`;

    try {
      await fetch(formspreeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          _subject: `💳 Your Peak Supplies Order ${orderRef} — Payment Ready`,
          to: email,
          customer_name: name,
          reference: orderRef,
          total_to_pay: `₦${amount?.toLocaleString()}`,
          payment_link: paymentUrl,
          message: emailBody,
        }),
      });
    } catch (emailErr) {
      console.warn("Email send error:", emailErr);
      // Don't fail the whole request if email fails
    }

    console.log(`✅ Payment link created for ${orderRef}: ${paymentUrl}`);
    return res.json({ success: true, paymentUrl });

  } catch (err) {
    console.error("Payment link error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


/* ════════════════════════════════════════
   REVOKE ORDER & REFUND CLIENT
   Admin clicks Revoke — triggers Paystack refund automatically
════════════════════════════════════════ */
app.post("/api/refund", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const limit = rateLimit(ip, 5, 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: "Too many requests" });

  try {
    const { orderRef, amount } = req.body;
    if (!orderRef) return res.status(400).json({ error: "Missing orderRef" });

    const paystackRef = "CHG-" + orderRef;

    // Issue refund via Paystack
    const refundRes = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PAYSTACK_SECRET}`,
      },
      body: JSON.stringify({
        transaction: paystackRef,
        amount: amount ? Math.round(amount * 100) : undefined, // full refund if no amount
      }),
    });

    const refundData = await refundRes.json();

    if (!refundData.status) {
      console.error("Paystack refund error:", refundData);
      return res.status(500).json({ error: refundData.message || "Refund failed" });
    }

    // Update Supabase — mark as cancelled
    await sb.from("orders").update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    }).eq("ref", orderRef);

    console.log(`✅ Refund issued for order ${orderRef}`);
    return res.json({ success: true, refund: refundData.data });

  } catch (err) {
    console.error("Refund error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Peak Supplies backend running on port ${PORT}`);
});
