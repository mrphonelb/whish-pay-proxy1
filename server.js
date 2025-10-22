const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");

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

// ====== Configuration ======
const WHISH_BASE = "https://api.sandbox.whish.money/itel-service/api";
const CHANNEL = "10196880";
const SECRET = "2faa0831c2a84f8d88d9066288b49991";
const WEBSITE_URL = "mrphonelb.com";
const API_KEY = "dd904f6a2745e5206ea595caac587a850e990504";

app.get("/", (_, res) => res.send("✅ Whish Pay Proxy Running OK"));

// ============ Create Whish Payment ============
app.post("/whish/create", async (req, res) => {
  try {
    const { orderId, amount, currency = "USD", description, client_id } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ error: "Missing orderId or amount" });
    }

    console.log(`💰 Creating Whish payment for Invoice #${orderId} (${amount} ${currency})`);

    const payload = {
  amount: numericAmount,
  currency: cur,
  invoice: `Invoice #${invoiceId}`,
  externalId: uniqueExternalId,
  successCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=success&invoice_id=${invoiceId}&amount=${numericAmount}&client_id=${clientId}`,
  failureCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=failure&invoice_id=${invoiceId}`,
  successRedirectUrl: `https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${invoiceId}&pm=whish`,
  failureRedirectUrl: `https://www.mrphonelb.com/client/contents/error?invoice_id=${invoiceId}&pm=whish`
};


    console.log("🔹 Sending payload to Whish:", JSON.stringify(payload, null, 2));

    const r = await axios.post(`${WHISH_BASE}/payment/whish`, payload, {
      headers: {
        channel: CHANNEL,
        secret: SECRET,
        websiteurl: WEBSITE_URL,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    console.log("🔹 Whish raw response (full):", JSON.stringify(r.data, null, 2));

    if (r.data?.data?.collectUrl) {
      return res.json({ redirect: r.data.data.collectUrl });
    }

    return res.status(400).json({ error: "Whish error", raw: r.data });
  } catch (err) {
    console.error("❌ Create error:", err.message);
    return res.status(500).json({ error: "Server error creating Whish payment" });
  }
});

// ============ Whish Callback ============
// =======================
// ✅ Whish Callback Handler
// =======================
app.get("/whish/callback", async (req, res) => {
  try {
    const invoice_id = req.query.invoice_id;
    const amount = parseFloat(req.query.amount || 0);
    const client_id = Number(req.query.client_id) || 20007;
    const result = req.query.result || "failure";

    console.log(`🔹 Whish callback for invoice ${invoice_id} (${result})`);

    if (result !== "success") {
      console.warn("❌ Whish payment failed");
      return res.redirect(`https://www.mrphonelb.com/client/contents/error?invoice_id=${invoice_id}`);
    }

    // ✅ Step 1 — Create Draft Invoice in Daftra
    const daftraResp = await fetch("https://www.mrphonelb.com/api2/invoices", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "apikey": "dd904f6a2745e5206ea595caac587a850e990504"
      },
      body: JSON.stringify({
        Invoice: {
          draft: 1,
          client_id: client_id,
          date: new Date().toISOString().split("T")[0],
          currency_code: "LBP",
          notes: `Whish Pay Invoice #${invoice_id}`
        },
        InvoiceItem: [
          {
            item: `Order #${invoice_id}`,
            description: "Payment via Whish Pay",
            unit_price: amount,
            quantity: 1
          }
        ]
      })
    });

    const daftraData = await daftraResp.json();
    console.log("🧾 Daftra invoice create response:", daftraData);

    if (!daftraData.id) {
      console.error("❌ Could not create Daftra draft:", daftraData);
      return res.redirect(`https://www.mrphonelb.com/client/contents/error?invoice_id=${invoice_id}`);
    }

    const newInvoiceId = daftraData.id;
    const netAmount = (amount / 1.01).toFixed(2);

    // ✅ Step 2 — Add Pending Payment
    const payResp = await fetch("https://www.mrphonelb.com/api2/invoice_payments", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "apikey": "dd904f6a2745e5206ea595caac587a850e990504"
      },
      body: JSON.stringify({
        InvoicePayment: {
          invoice_id: newInvoiceId,
          payment_method: "Whish_Pay",
          amount: Number(netAmount),
          transaction_id: `WP-${invoice_id}`,
          treasury_id: 0,
          status: 2, // pending
          processed: 0,
          notes: `Pending Whish Pay confirmation for Invoice #${invoice_id}`,
          currency_code: "LBP",
          response_message: "Awaiting settlement confirmation"
        }
      })
    });

    const payData = await payResp.json();
    console.log("💰 Daftra payment create response:", payData);

    // ✅ Step 3 — Redirect to Thank-You
    return res.redirect(`https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${invoice_id}&pm=whish`);

  } catch (err) {
    console.error("❌ Callback error:", err);
    return res.redirect("https://www.mrphonelb.com/client/contents/error");
  }
});


// ============ Health Check ============
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy listening on port ${PORT}`));
