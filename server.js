
import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
app.use(
  cors({
    origin: ["https://www.mrphonelb.com", "https://mrphonelb.com"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: false
  })
);

// ====== Whish sandbox base (keep sandbox while testing) ======
const WHISH_BASE =
  process.env.WHISH_BASE || "https://api.sandbox.whish.money/itel-service/api";

// ====== Required headers for Whish API ======
function whishHeaders() {
  return {
    channel: process.env.WHISH_CHANNEL,
    secret: process.env.WHISH_SECRET,
    websiteurl: process.env.WHISH_WEBSITE_URL,
    "Content-Type": "application/json"
  };
}

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://mrphone-backend.onrender.com
const SUCCESS_REDIRECT_URL =
  process.env.SUCCESS_REDIRECT_URL ||
  "https://www.mrphonelb.com/client/contents/thankyou";
const FAIL_REDIRECT_URL =
  process.env.FAIL_REDIRECT_URL ||
  "https://www.mrphonelb.com/client/contents/pay_error";
const PENDING_REDIRECT_URL =
  process.env.PENDING_REDIRECT_URL ||
  "https://www.mrphonelb.com/client/contents/order_summary";

app.get("/", (_req, res) => res.send("✅ Whish proxy up"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// Sanity check: balance
app.get("/whish/balance", async (_req, res) => {
  try {
    console.log("🔹 Checking Whish balance...");
    console.log("Headers sent:", whishHeaders());

    const r = await fetch(`${WHISH_BASE}/payment/account/balance`, {
      method: "GET",
      headers: whishHeaders(),
    });

    const text = await r.text();
    console.log("🔹 Whish raw response (first 300 chars):", text.slice(0, 300));

    // try to parse JSON if possible
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.log("❌ Not valid JSON. Returning raw HTML.");
      return res
        .status(r.status)
        .send({ error: "html_response", html: text.slice(0, 300) });
    }

    res.status(r.ok ? 200 : 400).json(data);
  } catch (e) {
    console.error("❌ Fetch error:", e);
    res.status(500).json({ error: e.message });
  }
});


// Create a payment (returns collectUrl)
app.post("/whish/create", async (req, res) => {
  try {
    let { orderId, amount, currency, description } = req.body;

    if (!orderId || amount == null)
      return res
        .status(400)
        .json({ error: "orderId and amount are required" });

    // Normalize
    const numericAmount =
      typeof amount === "string"
        ? Number(amount.replace(/,/g, ""))
        : Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0)
      return res.status(400).json({ error: "invalid amount" });

    // externalId must be numeric as per spec (Long)
    const externalId = Number(orderId);
    if (!Number.isFinite(externalId))
      return res.status(400).json({ error: "orderId must be numeric" });

    if (!PUBLIC_BASE_URL)
      return res.status(500).json({ error: "missing PUBLIC_BASE_URL env var" });

    // Default currency fallback
    const cur = (currency || "LBP").toUpperCase();

    const payload = {
      amount: numericAmount,
      currency: cur, // LBP / USD / AED
      invoice: description || `Order #${orderId}`,
      externalId: externalId,
      // Whish hits these FIRST (GET), we will double-check status then redirect:
      successCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=success&orderId=${encodeURIComponent(
        orderId
      )}&currency=${cur}`,
      failureCallbackUrl: `${PUBLIC_BASE_URL}/whish/callback?result=failure&orderId=${encodeURIComponent(
        orderId
      )}&currency=${cur}`,
      // After user finishes on Whish UI, they get redirected here:
      successRedirectUrl: `${SUCCESS_REDIRECT_URL}?invoice_id=${encodeURIComponent(
        orderId
      )}&pm=whish`,
      failureRedirectUrl: `${FAIL_REDIRECT_URL}?invoice_id=${encodeURIComponent(
        orderId
      )}&pm=whish`
    };

    const r = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await r.json();

    if (!r.ok || !data.status || !data?.data?.collectUrl) {
      return res
        .status(400)
        .json({ error: data?.dialog || "Whish error", raw: data });
    }

    res.json({ redirect: data.data.collectUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// Callback (Whish calls this via GET). We double-check status then redirect user.
app.get("/whish/callback", async (req, res) => {
  try {
    const orderId = req.query.orderId;
    const currency = (req.query.currency || "LBP").toUpperCase();

    if (!orderId) {
      return res.redirect(
        `${FAIL_REDIRECT_URL}?pm=whish&error=missing_order_id`
      );
    }

    const r = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency, externalId: Number(orderId) })
    });
    const js = await r.json();
    const status = (js?.data?.collectStatus || "").toLowerCase();

    if (status === "success") {
      return res.redirect(
        `${SUCCESS_REDIRECT_URL}?invoice_id=${encodeURIComponent(
          orderId
        )}&pm=whish`
      );
    } else if (status === "failed") {
      return res.redirect(
        `${FAIL_REDIRECT_URL}?invoice_id=${encodeURIComponent(
          orderId
        )}&pm=whish`
      );
    } else {
      return res.redirect(
        `${PENDING_REDIRECT_URL}?invoice_id=${encodeURIComponent(
          orderId
        )}&pm=whish&pending=1`
      );
    }
  } catch (e) {
    console.error("callback error", e);
    return res.redirect(
      `${FAIL_REDIRECT_URL}?pm=whish&error=callback_exception`
    );
  }
});

// Manual status checker (optional)
app.post("/whish/status", async (req, res) => {
  try {
    const { orderId, currency = "LBP" } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId required" });
    const r = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency: currency.toUpperCase(), externalId: Number(orderId) })
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 400).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Listening on", PORT));
