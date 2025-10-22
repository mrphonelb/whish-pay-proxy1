// =======================================================
// 🟣 MrPhoneLB Whish Pay Proxy
// =======================================================
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const dotenv = require("dotenv");
const fetch = require("node-fetch");
const axios = require("axios");

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

// =======================================================
// 🔧 CONFIGURATION
// =======================================================
const WHISH_BASE = "https://api.sandbox.whish.money/itel-service/api";
const CHANNEL = "10196880";
const SECRET = "2faa0831c2a84f8d88d9066288b49991";
const WEBSITE = "https://www.mrphonelb.com"; // Whitelisted domain
const PUBLIC_BASE_URL = "https://whish-pay-proxy-ahs0.onrender.com";

const SUCCESS_REDIRECT_URL =
  "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL =
  "https://www.mrphonelb.com/client/contents/error";
const PENDING_REDIRECT_URL =
  "https://www.mrphonelb.com/client/contents/order_summary";

const DAFTRA_API_KEY =
  "dd904f6a2745e5206ea595caac587a850e990504";

// =======================================================
// 🧱 HELPERS
// =======================================================
function whishHeaders() {
  return {
    channel: CHANNEL,
    secret: SECRET,
    websiteurl: WEBSITE,
    "Content-Type": "application/json",
  };
}

// =======================================================
// 🩺 HEALTH CHECK
// =======================================================
app.get("/", (_, res) => res.send("✅ Whish Pay Proxy Running OK"));
app.get("/health", (_, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// =======================================================
// 💰 CHECK BALANCE
// =======================================================
app.get("/whish/balance", async (_req, res) => {
  try {
    console.log("🔹 Checking Whish balance...");
    const r = await fetch(`${WHISH_BASE}/payment/account/balance`, {
      method: "GET",
      headers: whishHeaders(),
    });

    const text = await r.text();
    console.log("🔹 Whish raw response (first 300 chars):", text.slice(0, 300));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.log("❌ HTML or invalid JSON:", text.slice(0, 300));
      return res.status(500).send({ error: "invalid_json", html: text });
    }

    res.status(r.ok ? 200 : 400).json(data);
  } catch (e) {
    console.error("❌ Balance fetch error:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================================================
// 🧾 CREATE PAYMENT
// =======================================================
app.post("/whish/create", async (req, res) => {
  try {
    const { invoice_id, amount, currency = "USD" } = req.body;

    if (!invoice_id || !amount) {
      return res.status(400).json({ error: "invoice_id and amount are required" });
    }

    const numericAmount = Number(amount);
    console.log(`💰 Creating Whish payment for Invoice #${invoice_id} (${numericAmount} ${currency})`);

    const payload = {
  amount: numericAmount,
  currency,
  invoice: `Invoice #${invoice_id}`,
  externalId: Number(invoice_id),
  channel: CHANNEL,
  secret: SECRET,
  websiteurl: "mrphonelb.com",
  successCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=success&invoice_id=${invoice_id}`,
  failureCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=failure&invoice_id=${invoice_id}`,
  successRedirectUrl: `${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`,
  failureRedirectUrl: `${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`
};


    console.log("🔹 Sending payload to Whish:", JSON.stringify(payload, null, 2));

    const r = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    console.log("🔹 Whish raw response (full):", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "invalid_json", raw: text });
    }

    if (!r.ok || !data?.status || !data?.data?.collectUrl) {
      console.error("❌ Whish error:", data);
      return res.status(400).json({ error: "Whish error", raw: data });
    }

    let redirect = data.data.collectUrl;
    if (redirect.includes("api.sandbox.whish.money")) {
      redirect = redirect.replace("api.sandbox.whish.money", "lb.sandbox.whish.money");
    }

    return res.json({ redirect });
  } catch (err) {
    console.error("❌ /whish/create exception:", err);
    res.status(500).json({ error: "server_error", details: err.message });
  }
});

// =======================================================
// 🔁 CALLBACK (after Whish payment)
// =======================================================
app.get("/whish/callback", async (req, res) => {
  try {
    const { invoice_id } = req.query;
    if (!invoice_id) {
      return res.redirect(`${FAIL_REDIRECT_URL}?error=missing_invoice`);
    }

    console.log(`🔁 Callback received for Invoice #${invoice_id}`);

    const r = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency: "USD", externalId: Number(invoice_id) }),
    });

    const js = await r.json();
    const status = (js?.data?.collectStatus || "").toLowerCase();
    console.log(`📦 Whish callback status = ${status}`);

    if (status === "success") {
      // Add pending payment to Daftra
      await axios.post(
        "https://www.mrphonelb.com/api2/invoice_payments",
        {
          InvoicePayment: {
            invoice_id: Number(invoice_id),
            payment_method: "Whish_Pay",
            amount: Number(js?.data?.amount || 0),
            status: "2", // pending
            processed: "0",
            notes: "Whish Pay Pending Verification",
            currency_code: "USD",
          },
        },
        { headers: { apikey: DAFTRA_API_KEY, "Content-Type": "application/json" } }
      );

      // Keep invoice as draft
      await axios.put(
        `https://www.mrphonelb.com/api2/invoices/${invoice_id}`,
        { Invoice: { draft: true } },
        { headers: { apikey: DAFTRA_API_KEY, "Content-Type": "application/json" } }
      );

      console.log(`✅ Daftra updated for Invoice #${invoice_id}`);
      return res.redirect(`${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`);
    } else if (status === "failed") {
      return res.redirect(`${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`);
    } else {
      return res.redirect(`${PENDING_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish&pending=1`);
    }
  } catch (err) {
    console.error("❌ Callback error:", err);
    return res.redirect(`${FAIL_REDIRECT_URL}?error=callback_exception`);
  }
});

// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy listening on ${PORT}`));
