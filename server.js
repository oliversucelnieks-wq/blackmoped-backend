// ============================================================
// Blackmoped Backend — AI Quote Generator
// ============================================================
// Deploy this on Render. Set environment variables:
//   OPENROUTER_API_KEY = your OpenRouter key (server-side only)
//   ALLOWED_ORIGIN = https://blackmoped.com  (and/or your dev URL)
// ============================================================

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config ----
const API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MODEL = process.env.MODEL || "anthropic/claude-3.5-sonnet";

if (!API_KEY) {
  console.error("FATAL: OPENROUTER_API_KEY environment variable is not set.");
  console.error("Set it in your Render dashboard under Environment.");
  process.exit(1);
}

// ---- Middleware ----
app.use(express.json({ limit: "100kb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(","),
    methods: ["GET", "POST"],
  })
);

// Rate limit: 20 quote generations per IP per hour (free tier protection)
const quoteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Try again in an hour.",
  },
});

// ---- The system prompt — the brain of Blackmoped ----
const SYSTEM_PROMPT = `You are Blackmoped, an AI quoting assistant for UK electricians.

Your job: take a job description (often messy, voice-note style, with trade lingo) and produce a fully itemised, professional quote that a UK electrician can send to a customer.

# UK ELECTRICAL CONTEXT (you must know this)

- **Part P** of the UK Building Regulations covers domestic electrical safety. Notifiable work (new circuits, consumer unit replacements, work in special locations like bathrooms/kitchens) must be certified.
- **BS 7671** is the wiring regulations (currently 18th edition, Amendment 2). All work must comply.
- **Certificates**: EIC (Electrical Installation Certificate) for new circuits/CU work; MWC (Minor Works Certificate) for additions to existing circuits; EICR (Electrical Installation Condition Report) for periodic inspection.
- **Common acronyms**: CU = consumer unit, RCBO = residual current breaker with overcurrent, RCD = residual current device, MCB = miniature circuit breaker, EV = electric vehicle, SWA = steel wire armoured, T&E = twin and earth.
- **VAT**: 20% standard rate. Some new-build work is zero-rated; energy-saving materials may be 5%. Default to 20% unless told otherwise.

# UK PRICING BASELINE (use unless user has set their own rates)

- Day rate: £280-£400/day depending on region
- Hourly: £45-£65/hour
- Call-out minimum: £80-£120
- Common job benchmarks (labour + materials, ex-VAT):
  - Single socket add: £80-£120
  - Double socket add: £100-£150
  - Light fitting swap: £60-£90
  - Light pendant new install: £120-£180
  - Consumer unit upgrade (10-way RCBO): £550-£800
  - Consumer unit upgrade (full rewire CU): £700-£1100
  - EICR 1-bed flat: £140-£180
  - EICR 3-bed house: £180-£280
  - EV charger install (7kW, simple run): £750-£1100
  - Full rewire 3-bed house: £4500-£7500
  - Cooker circuit new: £250-£400

Adjust upward 15-25% for London/SE England.

# OUTPUT FORMAT — CRITICAL

You must respond with ONLY valid JSON. No markdown fences, no preamble, no explanation. Just the JSON object.

Schema:
{
  "summary": "One-sentence plain-English description of the work",
  "items": [
    {
      "description": "Clear line item the customer will understand",
      "qty": 1,
      "unit_price_pence": 28500,
      "category": "labour" | "materials" | "certification" | "callout" | "other"
    }
  ],
  "subtotal_pence": 138900,
  "vat_pence": 27780,
  "total_pence": 166680,
  "notifiable_work": true,
  "certificate_required": "EIC" | "MWC" | "EICR" | "none",
  "compliance_notes": "Short note about Part P / BS 7671 implications, e.g. 'CU replacement is notifiable under Part P. EIC will be issued on completion. Work complies with BS 7671:2018+A2:2022.'",
  "assumptions": [
    "List any assumptions you made (e.g. existing wiring is in good condition, no chasing required, customer provides parking)"
  ],
  "estimated_duration": "e.g. '1 day' or '4 hours' or '3-4 days'"
}

All money values are in PENCE (integers). 1526 pounds = 152600 pence. Do the math correctly.

# RULES

1. Always output VALID JSON — no surrounding text, no markdown.
2. Always include VAT at 20% unless the job is clearly zero-rated.
3. Be itemised. Don't lump everything into one line.
4. If the job description is genuinely unclear or impossible (e.g. "fix my computer"), return: {"error": "This doesn't look like an electrical job. Try describing what needs doing — sockets, lights, consumer unit, EICR, etc."}
5. Use realistic UK pricing. Don't undercharge or overcharge dramatically.
6. Flag notifiable work honestly.
7. List sensible assumptions so the electrician can edit if wrong.
8. Currency in pence as integers. £19.50 = 1950 pence.`;

// ---- Health check ----
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "blackmoped-backend",
    model: MODEL,
  });
});

// ---- Quote generation endpoint ----
app.post("/api/quote", quoteLimiter, async (req, res) => {
  try {
    const { jobDescription, electrician } = req.body || {};

    if (!jobDescription || typeof jobDescription !== "string") {
      return res.status(400).json({
        error: "Missing 'jobDescription' (string) in request body.",
      });
    }

    if (jobDescription.length < 10) {
      return res.status(400).json({
        error: "Job description too short. Give us a bit more detail.",
      });
    }

    if (jobDescription.length > 4000) {
      return res.status(400).json({
        error: "Job description too long. Keep it under 4000 characters.",
      });
    }

    // Build user message — include any electrician context
    let userMessage = `Job description:\n${jobDescription}`;

    if (electrician && typeof electrician === "object") {
      const ctx = [];
      if (electrician.region) ctx.push(`Region: ${electrician.region}`);
      if (electrician.dayRate) ctx.push(`Day rate: £${electrician.dayRate}`);
      if (electrician.hourlyRate)
        ctx.push(`Hourly rate: £${electrician.hourlyRate}`);
      if (electrician.materialMarkup)
        ctx.push(`Material markup: ${electrician.materialMarkup}%`);
      if (ctx.length > 0) {
        userMessage += `\n\nElectrician context:\n${ctx.join("\n")}`;
      }
    }

    // Call OpenRouter
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://blackmoped.com",
          "X-Title": "Blackmoped",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: 2000,
          response_format: { type: "json_object" },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenRouter error:", response.status, errText);
      return res.status(502).json({
        error: "AI service is having a moment. Try again in a few seconds.",
      });
    }

    const data = await response.json();
    const aiContent = data?.choices?.[0]?.message?.content;

    if (!aiContent) {
      return res.status(502).json({
        error: "Got an empty response from the AI. Try again.",
      });
    }

    // Parse JSON — strip markdown fences just in case
    let quote;
    try {
      const cleaned = aiContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      quote = JSON.parse(cleaned);
    } catch (err) {
      console.error("Failed to parse AI JSON:", aiContent);
      return res.status(502).json({
        error:
          "AI returned something we couldn't parse. Try rewording the job.",
      });
    }

    if (quote.error) {
      return res.status(400).json({ error: quote.error });
    }

    // Sanity check the structure
    if (!Array.isArray(quote.items) || typeof quote.total_pence !== "number") {
      return res.status(502).json({
        error: "AI returned a malformed quote. Try again.",
      });
    }

    return res.json({
      success: true,
      quote,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Quote generation error:", err);
    return res.status(500).json({
      error: "Something went wrong on our end. Try again.",
    });
  }
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`Blackmoped backend running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
});
