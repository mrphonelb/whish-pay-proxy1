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

// ====== ENV CONFIG ======
const WHISH_BASE = "https://api.sandbox.whish.money/itel-service/api";
const CHANNEL = "10196880";
const SECRET = "2faa0831c2a84f8d88d9066288b49991";
const WEBSITE = "mrphonelb.com";
const PUBLIC_BASE_URL = "https://whish-pay-proxy-ahs0.onrender.com";
const SUCCESS_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL = "https://www.mrphonelb.com/client/contents/error";
const DAFTRA_API_KEY = "dd904f6a2745e5206ea595caac587a850e990504";

function whishHeaders() {
  return {
    channel: CHANNEL,
    secret: SECRET,
    websiteurl: WEBSITE,
    "Content-Type": "application/json",
  };
}

app.get("/", (_, res) => res.send("✅ Whish Pay Proxy Live"));

/* ======================================================
   1️⃣ CREATE PAYMENT
====================================================== */
app.post("/whish/create", async (req, res) => {
  try {
    const { invoice_id, amount, currency = "USD" } = req.body;
    if (!invoice_id || !amount)
      return res.status(400).json({ error: "invoice_id and amount required" });

    console.log(`💰 Creating Whish payment for invoice ${invoice_id}`);

    const payload = {
      amount: Number(amount),
      currency,
      invoice: `Invoice #${invoice_id}`,
      externalId: Number(invoice_id),
      successCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=success&invoice_id=${invoice_id}`,
      failureCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=failure&invoice_id=${invoice_id}`,
      successRedirectUrl: `${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`,
      failureRedirectUrl: `${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`,
    };

    const r = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("❌ Invalid JSON from Whish:", text.slice(0, 200));
      return res.status(500).json({ error: "invalid_json", raw: text.slice(0, 200) });
    }

    if (!data?.status || !data?.data?.collectUrl)
      return res.status(400).json({ error: "Whish error", raw: data });

    const redirect = data.data.collectUrl.replace(
      "api.sandbox.whish.money",
      "lb.sandbox.whish.money"
    );

    res.json({ redirect });
  } catch (err) {
    console.error("❌ Create error:", err);
    res.status(500).json({ error: "server_error", details: err.message });
  }
});

/* ======================================================
   2️⃣ CALLBACK AFTER PAYMENT
====================================================== */
app.get("/whish/callback", async (req, res) => {
  try {
    const { invoice_id } = req.query;
    console.log(`🔁 Callback for invoice ${invoice_id}`);

    const r = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency: "USD", externalId: Number(invoice_id) }),
    });

    const js = await r.json();
    const status = (js?.data?.collectStatus || "").toLowerCase();

    if (status === "success") {
      // ✅ Add pending payment to Daftra and keep draft
      await axios.post(
        "https://www.mrphonelb.com/api2/invoice_payments",
        {
          InvoicePayment: {
            invoice_id: Number(invoice_id),
            payment_method: "Whish_Pay",
            amount: Number(js?.data?.amount || 0),
            status: "2", // pending
            processed: "0",
            response_message: "Whish Pay Pending Verification",
            notes: "Whish Pay transaction pending approval",
            currency_code: "USD",
          },
        },
        { headers: { apikey: DAFTRA_API_KEY, "Content-Type": "application/json" } }
      );

      await axios.put(
        `https://www.mrphonelb.com/api2/invoices/${invoice_id}`,
        { Invoice: { draft: true } },
        { headers: { apikey: DAFTRA_API_KEY, "Content-Type": "application/json" } }
      );

      console.log(`✅ Draft ${invoice_id} kept + pending Whish payment added`);
      return res.redirect(`${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}`);
    }

    console.warn(`⚠️ Whish status = ${status}`);
    return res.redirect(`${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}`);
  } catch (err) {
    console.error("❌ Callback error:", err);
    return res.redirect(`${FAIL_REDIRECT_URL}?error=callback_exception`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Whish Pay Proxy listening on", PORT));
