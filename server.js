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
    credentials: false,
  })
);

// ============================================================
// ✅  CONFIGURATION
// ============================================================
const WHISH_BASE =
  process.env.WHISH_BASE || "https://api.sandbox.whish.money/itel-service/api";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://whish-pay-proxy-ahs0.onrender.com";

const SUCCESS_REDIRECT_URL =
  process.env.SUCCESS_REDIRECT_URL ||
  "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL =
  process.env.FAIL_REDIRECT_URL ||
  "https://www.mrphonelb.com/client/contents/error";
const PENDING_REDIRECT_URL =
  process.env.PENDING_REDIRECT_URL ||
  "https://www.mrphonelb.com/client/contents/order_summary";

// 🔑 Daftra API key for invoice creation (keep private)
const DAFTRA_API_KEY = "dd904f6a2745e5206ea595caac587a850e990504";

// ============================================================
// ✅  ROUTES
// ============================================================

// Health check
app.get("/", (_, res) => res.send("✅ Whish Pay Proxy is running fine!"));
app.get("/health", (_, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// ============================================================
// 💰 GET BALANCE (Whish sandbox test)
// ============================================================
app.get("/whish/balance", async (_, res) => {
  try {
    console.log("🔹 Checking Whish balance...");
    const response = await fetch(`${WHISH_BASE}/payment/account/balance`, {
      method: "GET",
      headers: {
        channel: "10196880",
        secret: "2faa0831c2a84f8d88d9066288b49991",
        websiteurl: "mrphonelb.com",
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();
    console.log("🔹 Whish raw balance response:", text.slice(0, 200));
    const data = JSON.parse(text);
    res.status(response.ok ? 200 : 400).json(data);
  } catch (err) {
    console.error("❌ Balance error:", err);
    res.status(500).json({ error: "server_error", details: err.message });
  }
});

// ============================================================
// 💳 CREATE PAYMENT (MAIN ROUTE)
// ============================================================
app.post("/whish/create", async (req, res) => {
  try {
    const { orderId, amount, currency, description } = req.body;

    if (!orderId || !amount)
      return res.status(400).json({ error: "Missing orderId or amount" });

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount))
      return res.status(400).json({ error: "Invalid amount" });

    const cur = (currency || "LBP").toUpperCase();

    console.log(
      `💰 Creating Whish payment for Invoice #${orderId} (${numericAmount} ${cur})`
    );

    // ✅ Build payload as required by Whish
    const payload = {
      amount: numericAmount,
      currency: cur,
      invoice: description || `Invoice #${orderId}`,
      externalId: Number(orderId),
      channel: "10196880", // must exist in body
      secret: "2faa0831c2a84f8d88d9066288b49991", // must exist in body
      websiteurl: "mrphonelb.com", // must exist in body
      successCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=success&invoice_id=${orderId}`,
      failureCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=failure&invoice_id=${orderId}`,
      successRedirectUrl: `${SUCCESS_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`,
      failureRedirectUrl: `${FAIL_REDIRECT_URL}?invoice_id=${orderId}&pm=whish`,
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
    console.log("🔹 Whish raw response (full):", text.slice(0, 400));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res
        .status(500)
        .json({ error: "Invalid JSON response", raw: text.slice(0, 400) });
    }

    if (!data?.status || !data?.data?.collectUrl) {
      console.error("❌ Whish error:", data);
      return res.status(400).json({ error: "Whish error", raw: data });
    }

    // ✅ Fix sandbox link host if needed
    let redirectUrl = data.data.collectUrl;
    if (redirectUrl.includes("api.sandbox.whish.money")) {
      redirectUrl = redirectUrl.replace(
        "api.sandbox.whish.money",
        "lb.sandbox.whish.money"
      );
    }

    res.json({ redirect: redirectUrl });
  } catch (err) {
    console.error("❌ Create error:", err);
    res.status(500).json({ error: "server_error", details: err.message });
  }
});

// ============================================================
// 🧾 CALLBACK (after payment page finishes)
// ============================================================
// ✅ Whish callback (create Daftra draft + pending payment, using API key only)
app.get("/whish/callback", async (req, res) => {
  const { invoice_id, result, amount } = req.query;
  if (!invoice_id) return res.status(400).send("Missing invoice_id");

  try {
    console.log(`🔹 Whish callback for invoice ${invoice_id} (${result})`);

    if (result === "success") {
      // Convert amount to number and remove Whish 1% fee
      const whishAmount = Number(amount) || 0;
      const netAmount = whishAmount / 1.01; // ✅ remove 1% Whish fee
      const roundedNet = Number(netAmount.toFixed(2));

      // Step 1️⃣ Create Daftra Draft Invoice
      const invoicePayload = {
        Invoice: {
          draft: 1, // ✅ stays as draft
          client_id: 1, // You can make this dynamic later
          date: new Date().toISOString().split("T")[0],
          currency_code: "USD",
          notes: `Whish Pay Invoice #${invoice_id}`,
        },
        InvoiceItem: [
          {
            item: `Order #${invoice_id}`,
            description: "Payment via Whish Pay",
            unit_price: roundedNet,
            quantity: 1,
          },
        ],
      };

      console.log("🧾 Creating Daftra draft invoice with payload:", invoicePayload);

      const invoiceRes = await axios.post(
        "https://www.mrphonelb.com/api2/invoices",
        invoicePayload,
        {
          headers: {
            Accept: "application/json",
            apikey: "dd904f6a2745e5206ea595caac587a850e990504",
            "Content-Type": "application/json",
          },
        }
      );

      const daftraInvoiceId = invoiceRes.data?.id;
      console.log("✅ Created Daftra draft invoice:", daftraInvoiceId);

      // Step 2️⃣ Add Pending Payment (status = 2)
      const paymentPayload = {
        InvoicePayment: {
          invoice_id: daftraInvoiceId,
          payment_method: "Whish Pay",
          amount: roundedNet, // ✅ merchant’s share
          transaction_id: `whish-${invoice_id}`,
          date: new Date().toISOString(),
          status: 2, // ✅ pending
          notes: `Awaiting Whish Pay confirmation. Original amount: ${whishAmount} USD (includes 1% fee)`,
          currency_code: "USD",
        },
      };

      console.log("💰 Creating Daftra pending payment with payload:", paymentPayload);

      const payRes = await axios.post(
        "https://www.mrphonelb.com/api2/invoice_payments",
        paymentPayload,
        {
          headers: {
            Accept: "application/json",
            apikey: "dd904f6a2745e5206ea595caac587a850e990504",
            "Content-Type": "application/json",
          },
        }
      );

      console.log("✅ Pending payment added:", payRes.data);

      // Redirect customer to thank-you page
      return res.redirect(
        `https://www.mrphonelb.com/client/contents/thankyou?invoice_id=${invoice_id}`
      );
    } else {
      console.log("❌ Payment failed or canceled");
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

// ============================================================
// 🚀 START SERVER
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy listening on port ${PORT}`));
