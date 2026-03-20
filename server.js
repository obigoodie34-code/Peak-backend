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
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || "*"; // your Netlify URL

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

app.listen(PORT, () => {
  console.log(`Peak Supplies backend running on port ${PORT}`);
});
