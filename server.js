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
      amount,
      currency,
      invoice: description || `Invoice #${orderId}`,
      externalId: orderId,
      successCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=success&invoice_id=${orderId}&amount=${amount}&client_id=${client_id}`,
      failureCallbackUrl: `https://whish-pay-proxy-ahs0.onrender.com/whish/callback?result=failure&invoice_id=${orderId}`,
      successRedirectUrl: `https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${orderId}&pm=whish`,
      failureRedirectUrl: `https://www.mrphonelb.com/client/contents/error?invoice_id=${orderId}&pm=whish`,
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
app.get("/whish/callback", async (req, res) => {
  const { invoice_id, result, amount, client_id } = req.query;

  console.log(`🔹 Whish callback for invoice ${invoice_id} (${result})`);

  try {
    if (result === "success") {
      const whishAmount = Number(amount) || 0;
      const netAmount = (whishAmount / 1.01).toFixed(2); // remove 1% fee

      // Step 1️⃣ Create Draft Invoice
      const invoicePayload = {
        Invoice: {
          draft: 1,
          client_id: Number(client_id) || 20007,
          date: new Date().toISOString().split("T")[0],
          currency_code: "USD",
          notes: `Whish Pay Invoice #${invoice_id}`,
        },
        InvoiceItem: [
          {
            item: `Order #${invoice_id}`,
            description: "Payment via Whish Pay",
            unit_price: Number(netAmount),
            quantity: 1,
          },
        ],
      };

      console.log("🧾 Creating Daftra draft invoice with payload:", invoicePayload);

      const invoiceRes = await axios.post("https://www.mrphonelb.com/api2/invoices", invoicePayload, {
        headers: {
          Accept: "application/json",
          apikey: API_KEY,
          "Content-Type": "application/json",
        },
      });

      const daftraInvoiceId = invoiceRes.data?.id;
      console.log("✅ Created Daftra draft invoice:", daftraInvoiceId);

      // Step 2️⃣ Add Pending Payment
      const paymentPayload = {
        InvoicePayment: {
          invoice_id: daftraInvoiceId,
          payment_method: "Whish Pay",
          amount: Number(netAmount),
          transaction_id: `whish-${invoice_id}`,
          date: new Date().toISOString(),
          status: 2, // pending
          notes: `Awaiting Whish Pay confirmation. Original amount: ${whishAmount} USD (includes 1% fee)`,
          currency_code: "USD",
        },
      };

      console.log("💰 Creating Daftra pending payment with payload:", paymentPayload);

      const payRes = await axios.post("https://www.mrphonelb.com/api2/invoice_payments", paymentPayload, {
        headers: {
          Accept: "application/json",
          apikey: API_KEY,
          "Content-Type": "application/json",
        },
      });

      console.log("✅ Pending payment added:", payRes.data);

      return res.redirect(
        `https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${invoice_id}`
      );
    } else {
      console.log("❌ Whish payment failed");
      return res.redirect(
        `https://www.mrphonelb.com/client/contents/error?invoice_id=${invoice_id}`
      );
    }
  } catch (err) {
    console.error("❌ Callback error:", err.response?.data || err.message);
    return res.redirect(
      `https://www.mrphonelb.com/client/contents/error?invoice_id=${invoice_id}`
    );
  }
});

// ============ Health Check ============
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy listening on port ${PORT}`));
