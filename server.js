const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const morgan = require("morgan");

dotenv.config();

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
app.use(
  cors({
    origin: ["https://www.mrphonelb.com", "https://mrphonelb.com"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ====== Whish sandbox base ======
const WHISH_BASE = "https://api.sandbox.whish.money/itel-service/api";

// ====== Required headers for Whish API ======
function whishHeaders() {
  return {
    channel: "10196880",
    secret: "2faa0831c2a84f8d88d9066288b49991",
    websiteurl: "mrphonelb.com",
    "Content-Type": "application/json",
  };
}

// ====== Redirect URLs ======
const SUCCESS_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/pay_error";
const PENDING_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/order_summary";

// ✅ Health check
app.get("/", (_req, res) => res.send("✅ Whish Pay Proxy Running OK"));

// ✅ Balance test
app.get("/whish/balance", async (_req, res) => {
  try {
    console.log("🔹 Checking Whish balance...");
    const r = await fetch(`${WHISH_BASE}/payment/account/balance`, {
      method: "GET",
      headers: whishHeaders(),
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (err) {
    console.error("❌ Balance check error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ✅ Create payment session
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

    const r = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json();
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

// ✅ Callback — verify payment
app.get("/whish/callback", async (req, res) => {
  try {
    const { orderId, result } = req.query;
    if (!orderId)
      return res.redirect(`${FAIL_REDIRECT_URL}?error=missing_order_id`);

    const r = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency: "USD", externalId: Number(orderId) }),
    });
    const js = await r.json();
    const status = js?.data?.collectStatus?.toLowerCase() || result;

    console.log(`📦 Whish callback for order ${orderId}:`, status);

    if (status === "success") {
      return res.redirect(`${SUCCESS_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`);
    } else if (status === "failed") {
      return res.redirect(`${FAIL_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`);
    } else {
      return res.redirect(`${PENDING_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`);
    }
  } catch (e) {
    console.error("callback error", e);
    return res.redirect(`${FAIL_REDIRECT_URL}?pm=whish&error=callback_exception`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Whish backend running on port", PORT));
