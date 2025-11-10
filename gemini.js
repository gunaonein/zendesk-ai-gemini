// gemini.js
import axios from "axios";

const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;

/**
 * generateReply(ticketPromptText, opts)
 * - ticketPromptText: string
 * - opts: { systemBrief?: string }
 * returns: drafted string (HTML/plain text)
 */
export async function generateReply(ticketPromptText, opts = {}) {
  const prompt = (opts.systemBrief || `
You are a Napster customer service agent named Guna.
Write a friendly, concise, Zendesk-safe HTML reply to the following customer message.
Keep paragraphs short, professional, and accurate. Use numbered steps if giving instructions.
Do NOT invent account details. If the message mentions billing/refund/account deletion, mark for human review by returning a short note starting with "[HUMAN REVIEW]".
`) + `

Customer message:
${ticketPromptText}
`.trim();

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY not set in environment");
    }

    const response = await axios.post(
      GEMINI_URL(process.env.GEMINI_API_KEY),
      {
        // Basic request shape for the v1beta generateContent endpoint.
        // Adjust fields if Google updates API surface.
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        // safety and response controls (optional)
        // You can tune temperature/response length through the API fields if available.
      },
      {
        headers: { "Content-Type": "application/json" }
      }
    );

    const data = response.data;

    // Typical path: data.candidates[0].content.parts[0].text
    const candidate = data?.candidates?.[0];
    const reply = candidate?.content?.parts?.[0]?.text ?? null;

    if (!reply) {
      console.error("Gemini returned unexpected shape:", JSON.stringify(data).slice(0, 2000));
      return "Sorry — couldn't generate a reply at the moment.";
    }

    // Basic trim and return
    return reply.trim();
  } catch (err) {
    console.error("generateReply error:", err?.response?.data ?? err.message ?? err);
    return "Error generating reply (AI service).";
  }
}
