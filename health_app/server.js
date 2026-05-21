const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const MEMORY_MIN_SCORE = Number(process.env.MEMORY_MIN_SCORE || 0.72);
const analysisCache = new Map();
const CACHE_LIMIT = 25;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
}

function memoryPayloadText(result) {
  return [
    `Product: ${result.product?.brand || ""} ${result.product?.productName || ""}`,
    `Category: ${result.product?.category || ""}`,
    `Ingredients: ${JSON.stringify(result.nutrition?.ingredients || result.product?.likelyIngredients || [])}`,
    `Nutrition: ${JSON.stringify(result.nutrition || {})}`,
    `Verification: ${JSON.stringify(result.verification || {})}`,
    `Meters: ${JSON.stringify(result.nutritionValue || {})}`,
    `Health: ${JSON.stringify(result.health || {})}`,
    `Benefits: ${JSON.stringify(result.benefits || {})}`,
    `Review: ${JSON.stringify(result.review || {})}`
  ].join("\n");
}

function runMemoryCommand(command, payload) {
  if (!MEMORY_ENABLED) {
    return { ok: false, disabled: true };
  }

  const script = path.join(ROOT, "scripts", "vector_store.py");
  const input = JSON.stringify(payload);
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

  for (const executable of candidates) {
    const result = spawnSync(executable, [script, command], {
      cwd: ROOT,
      input,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        CHROMA_DB_DIR: process.env.CHROMA_DB_DIR || path.join(ROOT, "chroma_db"),
        MEMORY_RECORD_DIR: process.env.MEMORY_RECORD_DIR || path.join(ROOT, "data", "memory_records")
      }
    });

    if (result.error && result.error.code === "ENOENT") continue;

    if (result.status !== 0) {
      return {
        ok: false,
        error: (result.stderr || result.stdout || "Memory command failed").slice(0, 500)
      };
    }

    try {
      return JSON.parse(result.stdout || "{}");
    } catch {
      return { ok: false, error: "Memory command returned invalid JSON" };
    }
  }

  return { ok: false, error: "Python was not found, so Chroma memory is unavailable." };
}

function queryMemory(query) {
  if (!query) return { ok: false };
  const result = runMemoryCommand("query", {
    query,
    min_score: MEMORY_MIN_SCORE,
    n_results: 3
  });
  return result;
}

function storeMemory(result, query) {
  const record = {
    ...result,
    storedAt: new Date().toISOString()
  };
  return runMemoryCommand("upsert", {
    query,
    productName: result.product?.productName || query || "food product",
    brand: result.product?.brand || "",
    text: memoryPayloadText(result),
    record
  });
}

function readJsonBody(req, limitBytes = 7_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error("Image payload is too large. Use an image under about 5 MB."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON payload."));
      }
    });

    req.on("error", reject);
  });
}

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callOpenAI(messages, responseFormat = "json_object", trace = {}) {
  if (!OPENAI_API_KEY) return null;

  const body = {
    model: OPENAI_MODEL,
    response_format: { type: responseFormat },
    store: true,
    metadata: {
      app: "health app",
      trace_id: trace.traceId || "unknown",
      agent: trace.agent || "unknown"
    },
    messages
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || "";
  return extractJson(content);
}

async function visionAgent({ imageDataUrl, hint, traceId }) {
  const fallback = {
    productName: hint || "Unknown food product",
    category: "food",
    visibleText: [],
    likelyIngredients: [],
    servingGuess: "100 g or one serving",
    confidence: OPENAI_API_KEY ? "low" : "demo",
    notes: OPENAI_API_KEY
      ? "The model could not confidently identify the product."
      : "Set OPENAI_API_KEY to enable real image recognition."
  };

  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a food label vision agent. Identify packaged foods, fruits, juices, snacks, or other food from images. Return only JSON."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analyze this food photo. Extract product name, brand if visible, category, visible label text, likely ingredients, serving size guess, and confidence. User hint: " +
              (hint || "none")
          },
          {
            type: "image_url",
            image_url: { url: imageDataUrl }
          }
        ]
      }
    ], "json_object", { traceId, agent: "vision-agent" })) || fallback
  );
}

async function textProductAgent({ hint, traceId }) {
  const fallback = {
    productName: hint,
    category: "food",
    visibleText: [],
    likelyIngredients: [],
    servingGuess: "100 g or one serving",
    confidence: "text-only",
    notes: "Product came from text search, not image recognition."
  };

  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a food product parser. Turn a user's typed food/product query into a structured product identity. Return only JSON."
      },
      {
        role: "user",
        content: `Product search text: ${hint}\n\nReturn productName, brand if obvious, category, likelyIngredients if obvious, servingGuess, confidence, and notes.`
      }
    ], "json_object", { traceId, agent: "text-product-agent" })) || fallback
  );
}

async function serperSearch(query) {
  if (!SERPER_API_KEY) {
    return {
      query,
      configured: false,
      results: [],
      note:
        "Set SERPER_API_KEY to enable Google Serper search. In Python/LangChain this is GoogleSerperAPIWrapper."
    };
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({ q: query, num: 6 })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Serper request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  return {
    query,
    configured: true,
    results: [
      ...(payload.answerBox ? [payload.answerBox] : []),
      ...(payload.organic || [])
    ]
      .slice(0, 6)
      .map((item) => ({
        title: item.title || item.source || "Result",
        link: item.link || "",
        snippet: item.snippet || item.answer || ""
      }))
  };
}

async function serperImageSearch(query) {
  if (!SERPER_API_KEY) {
    return {
      query,
      configured: false,
      images: []
    };
  }

  const response = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({ q: query, num: 5 })
  });

  if (!response.ok) {
    return {
      query,
      configured: true,
      images: []
    };
  }

  const payload = await response.json();
  return {
    query,
    configured: true,
    images: (payload.images || [])
      .slice(0, 5)
      .map((item) => ({
        title: item.title || "Product image",
        imageUrl: item.imageUrl || item.thumbnailUrl || "",
        source: item.source || "",
        link: item.link || ""
      }))
      .filter((item) => item.imageUrl)
  };
}

async function nutritionAgent({ product, search, traceId }) {
  const fallbackNutrition = {
    calories: "Unknown",
    protein: "Unknown",
    carbs: "Unknown",
    sugar: "Unknown",
    fat: "Unknown",
    fiber: "Unknown",
    sodium: "Unknown",
    ingredients: product.likelyIngredients || [],
    additivesOfConcern: [],
    evidenceQuality: search.configured ? "search-only" : "demo"
  };

  if (!OPENAI_API_KEY) return fallbackNutrition;

  const evidence = search.results
    .map((item, index) => `${index + 1}. ${item.title}\n${item.snippet}\n${item.link}`)
    .join("\n\n");

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a nutrition extraction agent. Use product identity and web snippets to estimate nutrition. Return only JSON."
      },
      {
        role: "user",
        content: `Product JSON:\n${JSON.stringify(product)}\n\nWeb evidence:\n${evidence}\n\nReturn calories, protein, carbs, sugar, fat, fiber, sodium, ingredients, additivesOfConcern, and evidenceQuality. Use Unknown when evidence is weak.`
      }
    ], "json_object", { traceId, agent: "nutrition-agent" })) || fallbackNutrition
  );
}

function fallbackVerification({ search, nutrition }) {
  const hasResults = Boolean(search.results && search.results.length);
  const nutritionText = JSON.stringify(nutrition).toLowerCase();
  const hasUnknowns = (nutritionText.match(/unknown/g) || []).length;

  return {
    verified: hasResults && hasUnknowns <= 3,
    approximate: hasResults && hasUnknowns <= 5,
    passable: hasResults && hasUnknowns <= 5,
    confidence: hasResults ? "medium" : "low",
    feedback: hasResults
      ? "Nutrition data was checked against available search snippets, but exact label confirmation may still require a product package or official source."
      : "No web evidence was available for verification.",
    missingOrConflictingFields: hasUnknowns > 3 ? ["Several nutrition fields are unknown."] : [],
    refinedQuery: ""
  };
}

async function verificationAgent({ product, search, nutrition, attempt, traceId }) {
  const fallback = fallbackVerification({ search, nutrition });
  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a nutrition verification and feedback agent. Verify if extracted nutrition values are supported by web evidence. If exact label data is unavailable but values are close/plausible across evidence, mark approximate and passable true. If not, give feedback and a better search query. Return only JSON."
      },
      {
        role: "user",
        content: `Attempt ${attempt}\n\nProduct:\n${JSON.stringify(product)}\n\nSearch evidence:\n${JSON.stringify(search.results)}\n\nExtracted nutrition:\n${JSON.stringify(nutrition)}\n\nReturn JSON with verified boolean, approximate boolean, passable boolean, confidence high/medium/low, feedback, missingOrConflictingFields array, and refinedQuery. verified=true means exact/strong evidence. approximate=true means values are close enough but not exact. passable=true means downstream health agents may run while clearly labeling values approximate.`
      }
    ], "json_object", { traceId, agent: "verification-agent" })) || fallback
  );
}

async function verifiedNutritionLoop({ product, initialQuery, traceId }) {
  const attempts = [];
  let query = initialQuery;
  let latestSearch = null;
  let latestNutrition = null;
  let latestVerification = null;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    latestSearch = await serperSearch(query);
    latestNutrition = await nutritionAgent({ product, search: latestSearch, traceId });
    latestVerification = await verificationAgent({
      product,
      search: latestSearch,
      nutrition: latestNutrition,
      attempt,
      traceId
    });

    attempts.push({
      attempt,
      query,
      verified: Boolean(latestVerification.verified),
      approximate: Boolean(latestVerification.approximate),
      passable: Boolean(latestVerification.passable || latestVerification.verified),
      feedback: latestVerification.feedback || "",
      missingOrConflictingFields: latestVerification.missingOrConflictingFields || []
    });

    if (latestVerification.verified || latestVerification.passable) break;

    const refined = String(latestVerification.refinedQuery || "").trim();
    if (!refined || refined.toLowerCase() === query.toLowerCase()) {
      query = `${product.brand || ""} ${product.productName || ""} nutrition facts label calories sugar sodium protein fiber official`.trim();
    } else {
      query = refined;
    }
  }

  return {
    search: latestSearch,
    nutrition: latestNutrition,
    verification: {
      ...(latestVerification || {}),
      verified: Boolean(latestVerification && latestVerification.verified),
      approximate: Boolean(latestVerification && latestVerification.approximate),
      passable: Boolean(latestVerification && (latestVerification.passable || latestVerification.verified)),
      attempts,
      maxAttempts
    }
  };
}

function numberFrom(value) {
  const match = String(value ?? "").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function fallbackNutritionMeters(nutrition) {
  const protein = numberFrom(nutrition.protein);
  const fiber = numberFrom(nutrition.fiber);
  const sugar = numberFrom(nutrition.sugar);
  const sodium = numberFrom(nutrition.sodium);
  const fat = numberFrom(nutrition.fat);
  const calories = numberFrom(nutrition.calories);

  return {
    servingBasis: "Per listed serving or best available evidence",
    meters: [
      { label: "Protein", value: clamp(protein * 8), status: protein >= 8 ? "good" : "low", note: nutrition.protein || "Unknown" },
      { label: "Fiber", value: clamp(fiber * 15), status: fiber >= 5 ? "good" : "low", note: nutrition.fiber || "Unknown" },
      { label: "Sugar", value: clamp(100 - sugar * 4), status: sugar > 15 ? "watch" : "good", note: nutrition.sugar || "Unknown" },
      { label: "Sodium", value: clamp(100 - sodium / 8), status: sodium > 400 ? "watch" : "good", note: nutrition.sodium || "Unknown" },
      { label: "Fat", value: clamp(100 - fat * 3), status: fat > 15 ? "watch" : "ok", note: nutrition.fat || "Unknown" },
      { label: "Calories", value: clamp(100 - Math.max(0, calories - 150) / 4), status: calories > 350 ? "watch" : "ok", note: nutrition.calories || "Unknown" }
    ],
    summary:
      "Meters are estimated from available nutrition evidence. Higher is generally better, except nutrients of concern are inverted.",
    confidence: nutrition.evidenceQuality || "estimated"
  };
}

async function nutritionValueAgent({ product, nutrition, search, traceId }) {
  const fallback = fallbackNutritionMeters(nutrition);
  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a nutrition-value agent. Convert nutrition evidence into user-friendly meter gauges. Return only JSON."
      },
      {
        role: "user",
        content: `Product:\n${JSON.stringify(product)}\n\nNutrition:\n${JSON.stringify(nutrition)}\n\nSearch evidence:\n${JSON.stringify(search.results)}\n\nReturn JSON with servingBasis, meters array, summary, and confidence. Each meter must have label, value 0-100, status good/ok/watch/low, and note. Include Protein, Fiber, Sugar, Sodium, Fat, and Calories where possible. For sugar/sodium/fat/calories, higher meter value should mean healthier/lower concern.`
      }
    ], "json_object", { traceId, agent: "nutrition-meter-agent" })) || fallback
  );
}

async function benefitsAgent({ product, nutrition, nutritionValue, traceId }) {
  const fallback = {
    expertBackstory:
      "This agent is modeled as a professional health and nutrition expert with strong medical knowledge, focused on practical, evidence-based food guidance.",
    benefits: ["May provide energy as part of a balanced diet."],
    bestFor: ["Occasional consumption based on personal goals and serving size."],
    watchFor: ["Check serving size, added sugar, sodium, allergens, and ingredient quality."],
    disclaimer: "Informational guidance only; not a diagnosis or personal medical advice."
  };
  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a professional health and nutrition expert with excellent medical knowledge. Explain likely health benefits carefully, without making disease-treatment claims. Return only JSON."
      },
      {
        role: "user",
        content: `Product:\n${JSON.stringify(product)}\n\nNutrition:\n${JSON.stringify(nutrition)}\n\nNutrition meters:\n${JSON.stringify(nutritionValue)}\n\nReturn expertBackstory, benefits array, bestFor array, watchFor array, and disclaimer.`
      }
    ], "json_object", { traceId, agent: "health-benefit-agent" })) || fallback
  );
}

async function prosConsAgent({ product, nutrition, health, benefits, traceId }) {
  const fallback = {
    stars: Math.max(1, Math.min(5, Math.round((health.score || 60) / 20))),
    pros: benefits.benefits || ["Easy to consume."],
    cons: health.reasons || ["Nutrition quality depends on serving size and ingredients."],
    buyingAdvice: health.betterChoice || "Compare ingredient list and choose lower sugar, sodium, and additives.",
    summary: health.verdict || "Use in moderation."
  };
  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a product review nutrition agent. Give balanced pros, cons, and a star rating. Return only JSON."
      },
      {
        role: "user",
        content: `Product:\n${JSON.stringify(product)}\n\nNutrition:\n${JSON.stringify(nutrition)}\n\nHealth verdict:\n${JSON.stringify(health)}\n\nBenefits:\n${JSON.stringify(benefits)}\n\nReturn stars from 1 to 5, pros array, cons array, buyingAdvice, and summary.`
      }
    ], "json_object", { traceId, agent: "pros-cons-agent" })) || fallback
  );
}

function ruleBasedHealth(nutrition, product) {
  const text = JSON.stringify({ nutrition, product }).toLowerCase();
  const concerns = [];

  if (text.includes("high sugar") || text.includes("added sugar")) concerns.push("Likely high sugar or added sugar.");
  if (text.includes("palm oil")) concerns.push("Contains palm oil or similar processed fats.");
  if (text.includes("preservative")) concerns.push("May contain preservatives.");
  if (text.includes("sodium") && /[4-9]\d{2,}|[1-9]\d{3,}/.test(text)) concerns.push("Sodium may be high.");
  if (product.category && /fruit|fresh/.test(String(product.category).toLowerCase())) concerns.push("Fresh foods are usually better than ultra-processed packaged foods.");

  return {
    verdict: concerns.length >= 2 ? "Limit" : concerns.length === 1 ? "Okay sometimes" : "Probably okay",
    score: concerns.length >= 2 ? 45 : concerns.length === 1 ? 68 : 78,
    reasons: concerns.length ? concerns : ["No major concern found from available evidence."],
    betterChoice:
      "Prefer whole foods, shorter ingredient lists, lower added sugar, lower sodium, and more fiber/protein.",
    disclaimer: "This is informational only, not medical advice."
  };
}

async function healthAgent({ product, nutrition, search, traceId }) {
  const fallback = ruleBasedHealth(nutrition, product);
  if (!OPENAI_API_KEY) return fallback;

  return (
    (await callOpenAI([
      {
        role: "system",
        content:
          "You are a health verdict agent. Decide if a food is healthy for general daily use. Be careful, evidence-based, and concise. Return only JSON."
      },
      {
        role: "user",
        content: `Product:\n${JSON.stringify(product)}\n\nNutrition:\n${JSON.stringify(nutrition)}\n\nSearch:\n${JSON.stringify(search.results)}\n\nReturn verdict, score 0-100, reasons array, betterChoice, and disclaimer.`
      }
    ], "json_object", { traceId, agent: "health-verdict-agent" })) || fallback
  );
}

async function analyzeFood(payload) {
  const hint = String(payload.hint || "").trim();
  const hasImage = Boolean(payload.imageDataUrl && payload.imageDataUrl.startsWith("data:image/"));
  const traceId = crypto.randomUUID();
  const cacheKey = !hasImage && hint ? hint.toLowerCase().replace(/\s+/g, " ").trim() : "";

  if (!hasImage && !hint) {
    throw new Error("Upload an image or type a product name.");
  }

  if (cacheKey && analysisCache.has(cacheKey)) {
    return {
      ...structuredClone(analysisCache.get(cacheKey)),
      cacheHit: true,
      memoryHit: false,
      traceId
    };
  }

  if (!hasImage && hint) {
    const memory = queryMemory(hint);
    if (memory.ok && memory.hit && memory.record) {
      return {
        ...memory.record,
        generatedAt: new Date().toISOString(),
        traceId,
        cacheHit: false,
        memoryHit: true,
        memory
      };
    }
  }

  const product = hasImage
    ? await visionAgent({
        imageDataUrl: payload.imageDataUrl,
        hint,
        traceId
      })
    : await textProductAgent({ hint, traceId });
  const memoryQuery = [product.brand, product.productName, product.category, hint].filter(Boolean).join(" ");

  if (hasImage || !hint) {
    const memory = queryMemory(memoryQuery);
    if (memory.ok && memory.hit && memory.record) {
      return {
        ...memory.record,
        generatedAt: new Date().toISOString(),
        traceId,
        cacheHit: false,
        memoryHit: true,
        memory
      };
    }
  }

  const imageSearch = hasImage
    ? {
        query: "",
        configured: false,
        images: [],
        selectedImageUrl: payload.imageDataUrl
      }
    : await serperImageSearch(
        [product.brand, product.productName, product.category, "food product image"].filter(Boolean).join(" ")
      );
  const productImageUrl = hasImage ? payload.imageDataUrl : imageSearch.images[0]?.imageUrl || "";
  const query = [
    product.brand,
    product.productName,
    product.category,
    "nutrition facts ingredients calories sugar sodium"
  ]
    .filter(Boolean)
    .join(" ");
  const verified = await verifiedNutritionLoop({ product, initialQuery: query, traceId });
  const search = verified.search;
  const nutrition = verified.nutrition;
  const verification = verified.verification;

  if (!verification.passable) {
    return {
      generatedAt: new Date().toISOString(),
      configured: {
        openai: Boolean(OPENAI_API_KEY),
        serper: Boolean(SERPER_API_KEY),
        model: OPENAI_MODEL
      },
      traceId,
      memoryHit: false,
      product,
      productImageUrl,
      imageSearch,
      search,
      nutrition,
      verification,
      blockedByVerification: true,
      message: "Nutrition data was not close enough to verified evidence, so the benefit and review agents did not run."
    };
  }

  if (verification.approximate && !verification.verified) {
    nutrition.dataStatus = "Approximate values";
    nutrition.approximationNote =
      verification.feedback || "Nutrition values are close to available evidence but not exact label-confirmed values.";
  } else {
    nutrition.dataStatus = "Verified values";
  }

  const [nutritionValue, health] = await Promise.all([
    nutritionValueAgent({ product, nutrition, search, traceId }),
    healthAgent({ product, nutrition, search, traceId })
  ]);
  const benefits = await benefitsAgent({ product, nutrition, nutritionValue, traceId });
  const review = await prosConsAgent({ product, nutrition, health, benefits, traceId });

  const result = {
    generatedAt: new Date().toISOString(),
    configured: {
      openai: Boolean(OPENAI_API_KEY),
      serper: Boolean(SERPER_API_KEY),
      model: OPENAI_MODEL
    },
    traceId,
    cacheHit: false,
    memoryHit: false,
    product,
    productImageUrl,
    imageSearch,
    search,
    nutrition,
    verification,
    blockedByVerification: false,
    nutritionValue,
    health,
    benefits,
    review
  };

  if (cacheKey) {
    if (analysisCache.size >= CACHE_LIMIT) {
      analysisCache.delete(analysisCache.keys().next().value);
    }
    analysisCache.set(cacheKey, structuredClone(result));
  }

  const memory = storeMemory(result, memoryQuery || hint);
  result.memory = {
    stored: Boolean(memory.ok),
    error: memory.ok ? "" : memory.error || ""
  };

  return result;
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, file, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/analyze-food" && req.method === "POST") {
      const payload = await readJsonBody(req);
      sendJson(res, 200, await analyzeFood(payload));
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Nutrition scanner running at http://localhost:${PORT}`);
});
