const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const morgan = require("morgan");
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

// ============================================================
// ✅ CONFIGURATION
// ============================================================
const WHISH_BASE =
  process.env.WHISH_BASE || "https://api.sandbox.whish.money/itel-service/api";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://whish-pay-proxy-ahs0.onrender.com";

const SUCCESS_REDIRECT_URL =
  "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL =
  "https://www.mrphonelb.com/client/contents/error";
const PENDING_REDIRECT_URL =
  "https://www.mrphonelb.com/client/contents/order_summary";

// 🔑 Daftra API key
const DAFTRA_API_KEY = "dd904f6a2745e5206ea595caac587a850e990504";
const DAFTRA_API = "https://www.mrphonelb.com/api2";

// ============================================================
// 💳 CREATE WHISH PAYMENT
// ============================================================
app.post("/whish/create", async (req, res) => {
  try {
    const { orderId, amount, currency, description, client_id } = req.body;
const clientId = Number(client_id) || 20007; // fallback

    if (!orderId || !amount)
      return res.status(400).json({ error: "Missing orderId or amount" });

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount))
      return res.status(400).json({ error: "Invalid amount" });

    const cur = (currency || "LBP").toUpperCase();

    // ✅ Make externalId numeric unique (prevents 404 on re-click)
    const uniqueExternalId = Number(`${orderId}${Date.now().toString().slice(-4)}`);

    console.log(`💰 Creating Whish payment for Invoice #${orderId} (${numericAmount} ${cur})`);

    const payload = {
      amount: numericAmount,
      currency: cur,
      invoice: description || `Invoice #${orderId}`,
      externalId: uniqueExternalId,
      successCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=success&invoice_id=${orderId}&amount=${numericAmount}&client_id=${client_id}`,
      failureCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=failure&invoice_id=${orderId}`,
      successRedirectUrl: encodeURI(`${SUCCESS_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`),
failureRedirectUrl: encodeURI(`${FAIL_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`),
    };

    console.log("🔹 Sending payload to Whish:", JSON.stringify(payload, null, 2));

    const response = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: {
        channel: "10196880",
        secret: "2faa0831c2a84f8d88d9066288b49991",
        websiteurl: "mrphonelb.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log("🔹 Whish raw response:", text.slice(0, 400));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "Invalid JSON from Whish", raw: text.slice(0, 200) });
    }

    if (!data?.status || !data?.data?.collectUrl) {
      console.error("❌ Whish error:", data);
      return res.status(400).json({ error: "Whish error", raw: data });
    }

    let redirectUrl = data.data.collectUrl.replace(
      "api.sandbox.whish.money",
      "lb.sandbox.whish.money"
    );

    res.json({ redirect: redirectUrl });
  } catch (err) {
    console.error("❌ Create error:", err);
    res.status(500).json({ error: "server_error", details: err.message });
  }
});

/* =========================================================
   🧾 WHISH CALLBACK → Keep Draft + Add Pending Payment
========================================================= */
app.get("/whish/callback", async (req, res) => {
  try {
    const { invoice_id, result, amount, client_id } = req.query;
    const clientId = Number(client_id) || 20007;
    const cur = "LBP";

    console.log(`🔹 Whish callback for invoice ${invoice_id} (${result})`);

    // =========================================================
    // 1️⃣ Double-check Whish payment status
    // =========================================================
    const verify = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: {
        channel: "10196880",
        secret: "2faa0831c2a84f8d88d9066288b49991",
        websiteurl: "mrphonelb.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currency: cur,
        externalId: Number(invoice_id),
      }),
    });

    const data = await verify.json();
    const status = (data?.data?.collectStatus || "").toUpperCase();
    const txnId = data?.data?.collectTransactionId || `WHISH-${invoice_id}`;
    const message = data?.dialog?.message || status || "Unknown status";

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: DAFTRA_API_KEY,
    };

    // =========================================================
    // 2️⃣ Handle SUCCESSFUL payment
    // =========================================================
    if (status === "SUCCESS") {
      console.log(`✅ Whish payment success for invoice ${invoice_id}`);

      // ✅ Calculate actual payment amount (remove +1%)
      const paidAmount = (Number(amount) / 1.01).toFixed(2);

      // ✅ Step 1: Add Pending Payment
      await axios.post(
        "https://www.mrphonelb.com/api2/invoice_payments",
        {
          InvoicePayment: {
            invoice_id: Number(invoice_id),
            payment_method: "Whish Pay",
            amount: Number(paidAmount),
            transaction_id: txnId,
            treasury_id: 0,
            status: 2, // pending
            processed: 0,
            response_message: "Pending approval (Whish Pay)",
            notes: `Whish Pay pending confirmation (Txn: ${txnId})`,
            currency_code: cur,
          },
        },
        { headers }
      );

      console.log(`💰 Added pending payment for draft #${invoice_id}`);

      // ✅ Step 2: Force invoice to remain draft
      await axios.put(
        `https://www.mrphonelb.com/api2/invoices/${invoice_id}`,
        { Invoice: { draft: true } },
        { headers }
      );

      console.log(`🧾 Draft #${invoice_id} kept as draft`);

      // ✅ Redirect to Thank You page
      return res.redirect(
        `${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`
      );
    }

    // =========================================================
    // 3️⃣ Handle FAILED payment
    // =========================================================
    if (status === "FAILED") {
      console.warn(`❌ Whish payment failed for invoice ${invoice_id}`);
      return res.redirect(
        `${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish&error=${encodeURIComponent(
          message
        )}`
      );
    }

    // =========================================================
    // 4️⃣ Handle PENDING or UNKNOWN
    // =========================================================
    console.log(`🕒 Whish payment pending for invoice ${invoice_id}`);
    return res.redirect(
      `${PENDING_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish&pending=1`
    );
  } catch (err) {
    console.error("❌ Whish callback error:", err.response?.data || err.message);
    return res.redirect(
      `${FAIL_REDIRECT_URL}?pm=whish&error=callback_exception`
    );
  }
});


// ============================================================
// 🚀 START
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy running on port ${PORT}`));
