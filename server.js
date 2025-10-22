const express = require("express");
const morgan = require("morgan");
const dotenv = require("dotenv");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

dotenv.config();

const app = express();
app.use(express.json());
app.use(morgan("tiny"));

/* ============================================================
   ✅ CORS FIX (Manual headers to allow mrphonelb.com)
   ============================================================ */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.mrphonelb.com");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

/* ============================================================
   🧩 BASE CONFIG
   ============================================================ */
const WHISH_BASE = "https://api.sandbox.whish.money/itel-service/api"; // ✅ correct sandbox base
const CHANNEL = "10196880";
const SECRET = "2faa0831c2a84f8d88d9066288b49991";
const WEBSITE_URL = "mrphonelb.com";

const SUCCESS_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/pay_error";
const PENDING_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/order_summary";

function whishHeaders() {
  return {
    channel: CHANNEL,
    secret: SECRET,
    websiteurl: WEBSITE_URL,
    "Content-Type": "application/json",
  };
}

/* ============================================================
   ✅ HEALTH CHECK
   ============================================================ */
app.get("/", (req, res) => {
  res.send("✅ Whish Pay Proxy Running OK");
});

/* ============================================================
   ✅ TEST ENDPOINT: Balance (with timeout + clear logs)
   ============================================================ */
app.get("/whish/balance", async (req, res) => {
  try {
    console.log("🔹 Checking Whish balance...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // ⏱ 15s timeout

    const response = await fetch(`${WHISH_BASE}/payment/account/balance`, {
      method: "GET",
      headers: whishHeaders(),
      signal: controller.signal,
    }).catch(err => {
      throw new Error("Network error: " + err.message);
    });

    clearTimeout(timeout);

    const text = await response.text();
    console.log("🔹 Raw Whish response:", text.slice(0, 300));

    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch {
      console.error("❌ Non-JSON balance response");
      return res.status(502).json({ error: "invalid_json", raw: text });
    }
  } catch (err) {
    console.error("❌ Balance fetch error:", err);
    return res.status(500).json({ error: err.message || "server_error" });
  }
});

/* ============================================================
   ✅ CREATE PAYMENT
   ============================================================ */
app.post("/whish/create", async (req, res) => {
  try {
    const { orderId, amount, currency = "USD", description } = req.body;
    if (!orderId || !amount)
      return res.status(400).json({ error: "Missing orderId or amount" });

    console.log(`💰 Creating Whish payment for Order #${orderId} (${amount} ${currency})`);

    const payload = {
      amount: Number(amount),
      currency,
      invoice: description || `Order #${orderId}`,
      externalId: Number(orderId),
      successCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=success&orderId=${orderId}`,
      failureCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=failure&orderId=${orderId}`,
      successRedirectUrl: `${SUCCESS_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`,
      failureRedirectUrl: `${FAIL_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`,
    };

    const response = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("❌ HTML or invalid response from Whish:", text.slice(0, 200));
      return res.status(500).json({ error: "invalid_whish_response", raw: text });
    }

    if (data?.status && data?.data?.collectUrl) {
      console.log("✅ Whish collect URL:", data.data.collectUrl);
      return res.json({ redirect: data.data.collectUrl });
    } else {
      console.error("❌ Whish Pay Error:", data);
      return res.status(400).json({ error: data.dialog?.message || "Whish error", raw: data });
    }
  } catch (err) {
    console.error("❌ Create error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* ============================================================
   ✅ CALLBACK (Verify after payment)
   ============================================================ */
app.get("/whish/callback", async (req, res) => {
  try {
    const { orderId, result } = req.query;
    if (!orderId)
      return res.redirect(`${FAIL_REDIRECT_URL}?error=missing_order_id`);

    const response = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency: "USD", externalId: Number(orderId) }),
    });

    const js = await response.json();
    const status = js?.data?.collectStatus?.toLowerCase() || result;

    console.log(`📦 Whish callback for order ${orderId}:`, status);

    if (status === "success") {
      return res.redirect(`${SUCCESS_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`);
    } else if (status === "failed") {
      return res.redirect(`${FAIL_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`);
    } else {
      return res.redirect(`${PENDING_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`);
    }
  } catch (err) {
    console.error("callback error", err);
    return res.redirect(`${FAIL_REDIRECT_URL}?pm=whish&error=callback_exception`);
  }
});

/* ============================================================
   ✅ START SERVER
   ============================================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Whish backend running on port", PORT));
