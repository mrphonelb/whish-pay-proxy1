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

// ============================================================
// 🧾 CALLBACK AFTER SUCCESS
// ============================================================
app.get("/whish/callback", async (req, res) => {
  try {
    const { invoice_id, amount, client_id, result } = req.query;

    console.log(`🔹 Whish callback for invoice ${invoice_id} (${result})`);

    if (result !== "success") {
      console.error("❌ Whish payment failed");
      return res.redirect(`${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}`);
    }

    // ✅ Step 1: Create Daftra Draft Invoice
    const draftPayload = {
      Invoice: {
        draft: 1,
        client_id: Number(client_id),
        date: new Date().toISOString().split("T")[0],
        currency_code: "LBP",
        notes: `Whish Pay draft invoice #${invoice_id}`,
      },
      InvoiceItem: [
        {
          item: `Order #${invoice_id}`,
          description: "Paid via Whish Pay",
          unit_price: 0,
          quantity: 1,
        },
      ],
    };

    console.log("🧾 Creating Daftra draft:", JSON.stringify(draftPayload, null, 2));

    const draftRes = await axios.post(`${DAFTRA_API}/invoices`, draftPayload, {
      headers: {
        apikey: DAFTRA_API_KEY,
        "Content-Type": "application/json",
      },
    });

    const newInvoiceId = draftRes.data.id;
    console.log("✅ Draft created in Daftra:", newInvoiceId);

    // ✅ Step 2: Create Pending Payment
    const paymentAmount = Number((Number(amount) / 1.01).toFixed(2));
    const paymentPayload = {
      InvoicePayment: {
        invoice_id: newInvoiceId,
        payment_method: "Whish Pay",
        amount: paymentAmount,
        status: 2, // Pending
        notes: `Pending Whish Pay for ${invoice_id}`,
        currency_code: "LBP",
      },
    };

    console.log("💵 Adding pending payment:", JSON.stringify(paymentPayload, null, 2));

    await axios.post(`${DAFTRA_API}/invoice_payments`, paymentPayload, {
      headers: {
        apikey: DAFTRA_API_KEY,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ Pending payment added successfully");

    return res.redirect(`${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}`);
  } catch (err) {
    console.error("❌ Callback error:", err.response?.data || err.message);
    return res.redirect(`${FAIL_REDIRECT_URL}?invoice_id=${req.query.invoice_id}`);
  }
});

// ============================================================
// 🚀 START
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy running on port ${PORT}`));
