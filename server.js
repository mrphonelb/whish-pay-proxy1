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

    const cur = (currency || "USD").toUpperCase();

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
app.get("/whish/callback", async (req, res) => {
  try {
    const { invoice_id, result } = req.query;
    const cur = "USD";

    console.log(`🔄 Callback received for invoice ${invoice_id} | result=${result}`);

    const response = await fetch(`${WHISH_BASE}/payment/collect/status`, {
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

    const data = await response.json();
    const status = (data?.data?.collectStatus || "").toLowerCase();
    const phone = data?.data?.payerPhoneNumber || "";

    console.log("📬 Whish callback status:", status);

    // ✅ Handle success
    if (status === "success") {
      // Create pending Daftra payment
      await axios.post(
        "https://www.mrphonelb.com/api2/invoice_payments",
        {
          InvoicePayment: {
            invoice_id: Number(invoice_id),
            payment_method: "Whish_Pay",
            amount: Number(data.amount || 0),
            status: "2", // Pending
            processed: "0",
            response_message: `Whish Pay success (${phone})`,
            notes: "Whish payment pending confirmation",
          },
        },
        {
          headers: {
            apikey: DAFTRA_API_KEY,
            "Content-Type": "application/json",
          },
        }
      );

      return res.redirect(
        `${SUCCESS_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`
      );
    }

    // ❌ Handle failure
    if (status === "failed") {
      return res.redirect(
        `${FAIL_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish`
      );
    }

    // 🕒 Pending or unknown
    return res.redirect(
      `${PENDING_REDIRECT_URL}?invoice_id=${invoice_id}&pm=whish&pending=1`
    );
  } catch (err) {
    console.error("❌ Callback error:", err);
    res.redirect(`${FAIL_REDIRECT_URL}?pm=whish&error=callback_exception`);
  }
});

// ============================================================
// 🚀 START SERVER
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish Pay Proxy listening on port ${PORT}`));
