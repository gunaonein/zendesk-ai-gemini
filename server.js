// server.js
import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { generateReply } from "./gemini.js";

dotenv.config();
const app = express();
app.use(express.json({ limit: "128kb" })); // ticket payloads can be large; adjust if needed

const PORT = process.env.PORT || 3000;

if (!process.env.ZENDESK_SUBDOMAIN || !process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN) {
  console.warn("ZENDESK_SUBDOMAIN, ZENDESK_EMAIL or ZENDESK_API_TOKEN missing — will error when posting to Zendesk.");
}

// --- Simple PII redaction stub (improve as needed) ---
function redactPII(text) {
  if (!text) return text;
  // very simple: mask email-like strings and phone numbers
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(\+?\d{1,3}[-.\s]?)?(\(?\d{2,4}\)?[-.\s]?)?[\d-.\s]{5,15}/g, "[phone]");
}

// --- Zendesk API helpers ---
function zendeskBaseUrl() {
  return `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
}

function zendeskAuthHeader() {
  // Zendesk API token auth: Base64 of "email/token:APITOKEN"
  const token = process.env.ZENDESK_API_TOKEN || "";
  const email = process.env.ZENDESK_EMAIL || "";
  const basic = Buffer.from(`${email}/token:${token}`).toString("base64");
  return `Basic ${basic}`;
}

async function postReplyToZendesk(ticketId, bodyHtml, isPublic = false) {
  const url = `${zendeskBaseUrl()}/tickets/${ticketId}.json`;
  const payload = {
    ticket: {
      comment: {
        body: bodyHtml,
        public: isPublic
      }
    }
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: zendeskAuthHeader()
  };

  const res = await axios.put(url, payload, { headers });
  return res.data;
}

// --- Security: optional shared secret header validator ---
function verifySecret(req) {
  if (!process.env.WEBHOOK_SHARED_SECRET) return true; // disabled if not configured
  const incoming = req.get("x-webhook-secret") || "";
  return incoming && incoming === process.env.WEBHOOK_SHARED_SECRET;
}

// --- Main webhook endpoint ---
app.post("/webhook/zendesk", async (req, res) => {
  try {
    if (!verifySecret(req)) {
      return res.status(401).json({ ok: false, error: "Invalid shared secret" });
    }

    // Zendesk webhook payload shapes vary depending on your trigger. We accept
    // a minimal set: ticket id and latest comment body (or ticket description).
    const payload = req.body;
    // Common Zendesk webhook payloads include `ticket` or `object` structure.
    // We'll attempt a few common paths — adjust for your hook format.
    const ticketId =
      payload?.ticket?.id || payload?.ticket_id || payload?.id || payload?.object?.id;

    const rawComment =
      payload?.comment?.body ||
      payload?.ticket?.latest_comment?.body ||
      payload?.object?.latest_comment?.body ||
      payload?.ticket?.description ||
      payload?.object?.description ||
      "";

    if (!ticketId) {
      console.warn("No ticket id found in payload:", payload);
      return res.status(400).json({ ok: false, error: "No ticket id in payload" });
    }

    // Basic redaction
    const redacted = redactPII(rawComment);

    // Safety check: if content mentions billing/refund/account deletion, escalate
    const lc = redacted.toLowerCase();
    const sensitiveKeywords = ["refund", "charge", "billing", "cancel subscription", "delete account", "terminate", "legal"];
    const isSensitive = sensitiveKeywords.some((k) => lc.includes(k));

    if (isSensitive) {
      // Post a private note that flags humans (do not auto-respond)
      const humanNote = `[HUMAN REVIEW] This ticket contains sensitive keywords (${sensitiveKeywords.join(
        ", "
      )}). Please review and reply manually.\n\nCustomer message (redacted):\n${redacted}`;
      if (process.env.AUTO_POST_HUMAN_FLAG === "true") {
        await postReplyToZendesk(ticketId, humanNote, false);
      }
      return res.status(200).json({ ok: true, note: "Flagged for human review" });
    }

    // Build the prompt text you send to Gemini (keep it short)
    const ticketPromptText = `Ticket #${ticketId}\n\nCustomer message:\n${redacted}\n\nKeep response short and helpful. Respond as Napster support agent 'Guna'.`;

    // Generate reply using Gemini
    const draft = await generateReply(ticketPromptText);

    // Optionally prepend a human-readable header
    const finalBody = `Hi,\n\n${draft}\n\n—\nGuna, Napster Customer Support`;

    // Post as a private note (public: false). Set true if you want public reply.
    await postReplyToZendesk(ticketId, finalBody, false);

    return res.status(200).json({ ok: true, ticketId, replyPreview: finalBody.slice(0, 600) });
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data ?? err.message ?? err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// health
app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
