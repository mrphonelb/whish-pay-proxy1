const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
app.use(
  cors({
    origin: ["https://www.mrphonelb.com", "https://mrphonelb.com"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

/* ===============================================
   🧠 CONFIGURATION
   =============================================== */
const WHISH_BASE = "https://api.sandbox.whish.money/itel-service/api";
const DAFTRA_API = "https://www.mrphonelb.com/api2";
const DAFTRA_KEY = process.env.DAFTRA_APIKEY; // your Daftra API key
const PORT = process.env.PORT || 10000;

/* ===============================================
   💳 CREATE WHISH PAYMENT
   =============================================== */
app.post("/whish/create", async (req, res) => {
  try {
    const { orderId, amount, currency = "LBP", description, client_id } = req.body;

    if (!orderId || !amount)
      return res.status(400).json({ error: "Missing orderId or amount" });

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0)
      return res.status(400).json({ error: "Invalid amount" });

    // ✅ Make externalId numeric and unique
    const invoiceNumeric = String(orderId).match(/\d+/)?.[0] || orderId;
    const uniqueExternalId = Number(`${invoiceNumeric}${Date.now().toString().slice(-5)}`);

    console.log(`💰 Creating Whish payment for Invoice #${orderId} (${numericAmount} ${currency})`);

    const payload = {
      amount: numericAmount,
      currency,
      invoice: description || `Invoice #${orderId}`,
      externalId: uniqueExternalId,
      successCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=success&invoice_id=${orderId}&amount=${numericAmount}&client_id=${client_id}`,
      failureCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=failure&invoice_id=${orderId}`,
      successRedirectUrl: `https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${orderId}&pm=whish`,
      failureRedirectUrl: `https://www.mrphonelb.com/client/contents/error?invoice_id=${orderId}&pm=whish`,
    };

    console.log("🔹 Sending payload to Whish:", JSON.stringify(payload, null, 2));

    const response = await axios.post(`${WHISH_BASE}/payment/whish`, payload, {
      headers: {
        channel: "10196880",
        secret: "2faa0831c2a84f8d88d9066288b49991",
        websiteurl: "mrphonelb.com",
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    const data = response.data;
    console.log("🔹 Whish raw response (full):", JSON.stringify(data, null, 2));

    if (!data?.status || !data?.data?.collectUrl) {
      console.error("❌ Whish error:", data);
      return res.status(400).json({ error: "Whish error", raw: data });
    }

    return res.json({ redirect: data.data.collectUrl });
  } catch (err) {
    console.error("❌ Create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* ===============================================
   🧾 CALLBACK HANDLER
   =============================================== */
app.get("/whish/callback", async (req, res) => {
  try {
    const { result, invoice_id, amount, client_id } = req.query;
    console.log(`🔹 Whish callback for invoice ${invoice_id} (${result})`);

    if (result !== "success") {
      console.error("❌ Whish payment failed");
      return res.redirect(`https://www.mrphonelb.com/client/contents/error?invoice_id=${invoice_id}`);
    }

    // ✅ Create Daftra Draft Invoice
    const draftPayload = {
      Invoice: {
        draft: 1,
        client_id: Number(client_id),
        date: new Date().toISOString().split("T")[0],
        currency_code: "LBP",
        notes: `Whish Pay Invoice #${invoice_id}`,
      },
      InvoiceItem: [
        {
          item: `Order #${invoice_id}`,
          description: "Payment via Whish Pay",
          unit_price: 0,
          quantity: 1,
        },
      ],
    };

    console.log("🧾 Creating Daftra draft invoice with payload:", JSON.stringify(draftPayload, null, 2));

    const daftraRes = await axios.post(`${DAFTRA_API}/invoices`, draftPayload, {
      headers: {
        "Content-Type": "application/json",
        apikey: DAFTRA_KEY,
      },
    });

    const invoiceCreated = daftraRes.data?.id;
    console.log("✅ Draft invoice created:", invoiceCreated);

    // ✅ Create pending payment
    const paymentAmount = Number((Number(amount) / 1.01).toFixed(2));

    const paymentPayload = {
      InvoicePayment: {
        invoice_id: invoiceCreated,
        payment_method: "Whish Pay",
        amount: paymentAmount,
        status: 2, // pending
        notes: `Pending payment for invoice #${invoice_id}`,
        currency_code: "LBP",
      },
    };

    console.log("💵 Creating Daftra payment with payload:", JSON.stringify(paymentPayload, null, 2));

    await axios.post(`${DAFTRA_API}/invoice_payments`, paymentPayload, {
      headers: {
        "Content-Type": "application/json",
        apikey: DAFTRA_KEY,
      },
    });

    console.log("✅ Pending payment added successfully");
    return res.redirect(`https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${invoice_id}`);
  } catch (err) {
    console.error("❌ Callback error:", err.response?.data || err.message);
    return res.redirect(`https://www.mrphonelb.com/client/contents/error?invoice_id=${req.query.invoice_id}`);
  }
});

/* ===============================================
   🩺 HEALTH
   =============================================== */
app.get("/", (_req, res) => res.send("✅ Whish proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
