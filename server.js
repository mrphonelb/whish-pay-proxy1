const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());
app.use(cors());

// ======================= CONFIG =======================
const WHISH_BASE = process.env.WHISH_BASE || "https://lb.sandbox.whish.money/itel-service/api";
const WHISH_CHANNEL = process.env.WHISH_CHANNEL || "10196880";
const WHISH_SECRET = process.env.WHISH_SECRET || "2faa0831c2a84f8d88d9066288b49991";
const WHISH_WEBSITE = process.env.WHISH_WEBSITE_URL || "mrphonelb.com";
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://whish-pay-proxy-ahs0.onrender.com";
const DAFTRA_API_KEY = process.env.DAFTRA_API_KEY || "dd904f6a2745e5206ea595caac587a850e990504";

const THANKYOU_URL = "https://www.mrphonelb.com/client/contents/thankyou";
const ERROR_URL = "https://www.mrphonelb.com/client/contents/pay_error";

const daftraHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
  apikey: DAFTRA_API_KEY,
};

function whishHeaders() {
  return {
    channel: WHISH_CHANNEL,
    secret: WHISH_SECRET,
    websiteurl: WHISH_WEBSITE,
    "Content-Type": "application/json",
  };
}

// ======================= HEALTH =======================
app.get("/", (_, res) => res.send("✅ Whish Pay Proxy Running OK"));

// ======================= 1️⃣ CREATE PAYMENT =======================
app.post("/whish/create-existing", async (req, res) => {
  try {
    const { invoice_id, total_gateway, currency = "USD" } = req.body || {};
    if (!invoice_id || !total_gateway)
      return res.status(400).json({ ok: false, error: "Missing invoice_id or total_gateway" });

    // Sandbox supports LBP only
    const cur = WHISH_BASE.includes("sandbox") && currency === "USD" ? "LBP" : currency;
    const amount = Number(String(total_gateway).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ ok: false, error: "Invalid amount" });

    const payload = {
      amount,
      currency: cur,
      invoice: `Order #${invoice_id} from MrPhoneLB`,
      externalId: Number(invoice_id),
      successCallbackUrl: `${PUBLIC_BASE}/whish/verify-existing?invoice_id=${invoice_id}&currency=${cur}`,
      failureCallbackUrl: `${PUBLIC_BASE}/whish/verify-existing?invoice_id=${invoice_id}&currency=${cur}`,
      successRedirectUrl: `${PUBLIC_BASE}/whish/verify-existing?invoice_id=${invoice_id}&currency=${cur}`,
      failureRedirectUrl: `${PUBLIC_BASE}/whish/verify-existing?invoice_id=${invoice_id}&currency=${cur}`,
    };

    console.log("🔹 Sending Whish payload:", payload);

    const r = await fetch(`${WHISH_BASE}/payment/whish`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    console.log("🔹 Whish response (raw):", text.slice(0, 300));
    const data = JSON.parse(text);

    if (!r.ok || !data.status || !data.data?.collectUrl)
      return res.status(400).json({ ok: false, error: "Whish error", raw: data });

    let redirectUrl = data.data.collectUrl;
    if (redirectUrl.includes("api.sandbox.whish.money")) {
      redirectUrl = redirectUrl.replace("api.sandbox.whish.money", "lb.sandbox.whish.money");
    }

    res.json({ ok: true, redirect: redirectUrl });
  } catch (err) {
    console.error("❌ /whish/create-existing error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ======================= 2️⃣ VERIFY PAYMENT =======================
app.get("/whish/verify-existing", async (req, res) => {
  try {
    const { invoice_id, currency = "USD" } = req.query;
    if (!invoice_id) return res.redirect(`${ERROR_URL}?invoice_id=unknown`);

    const cur = WHISH_BASE.includes("sandbox") && currency === "USD" ? "LBP" : currency;

    const statusResp = await fetch(`${WHISH_BASE}/payment/collect/status`, {
      method: "POST",
      headers: whishHeaders(),
      body: JSON.stringify({ currency: cur, externalId: Number(invoice_id) }),
    });
    const statusJson = await statusResp.json();
    console.log("🔎 Whish status response:", statusJson);

    const collect = (statusJson?.data?.collectStatus || "").toLowerCase();
    const phone = statusJson?.data?.payerPhoneNumber || "N/A";

    if (collect !== "success") {
      return res.redirect(
        `${ERROR_URL}?invoice_id=${invoice_id}&status=${collect || "failed"}&pm=whish`
      );
    }

    // ✅ Payment success → Add pending record in Daftra
    await fetch("https://www.mrphonelb.com/api2/invoice_payments", {
      method: "POST",
      headers: daftraHeaders,
      body: JSON.stringify({
        InvoicePayment: {
          invoice_id: Number(invoice_id),
          payment_method: "Whish_Pay",
          transaction_id: `WHISH-${phone}`,
          status: "2", // pending
          processed: "0",
          response_message: "Pending approval (Whish verification)",
          notes: `Whish payment pending for invoice ${invoice_id}`,
          treasury_id: 0,
          currency_code: cur,
        },
      }),
    });

    // Keep invoice as draft
    await fetch(`https://www.mrphonelb.com/api2/invoices/${invoice_id}`, {
      method: "PUT",
      headers: daftraHeaders,
      body: JSON.stringify({ Invoice: { draft: true } }),
    });

    res.redirect(`${THANKYOU_URL}?invoice_id=${invoice_id}&pm=whish`);
  } catch (err) {
    console.error("❌ /whish/verify-existing error:", err);
    res.redirect(`${ERROR_URL}?invoice_id=unknown`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Whish backend running on port ${PORT}`));

