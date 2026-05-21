const els = {
  form: document.querySelector("#scanForm"),
  imageInput: document.querySelector("#imageInput"),
  hintInput: document.querySelector("#hintInput"),
  preview: document.querySelector("#preview"),
  statusText: document.querySelector("#statusText"),
  analyzeButton: document.querySelector("#analyzeButton"),
  downloadPdfButton: document.querySelector("#downloadPdfButton"),
  downloadHtmlButton: document.querySelector("#downloadHtmlButton"),
  configPill: document.querySelector("#configPill"),
  results: document.querySelector("#results"),
  verdictText: document.querySelector("#verdictText"),
  scoreText: document.querySelector("#scoreText"),
  reasonsList: document.querySelector("#reasonsList"),
  betterChoice: document.querySelector("#betterChoice"),
  productDetails: document.querySelector("#productDetails"),
  nutritionDetails: document.querySelector("#nutritionDetails"),
  verificationStatus: document.querySelector("#verificationStatus"),
  verificationFeedback: document.querySelector("#verificationFeedback"),
  verificationAttempts: document.querySelector("#verificationAttempts"),
  meterSummary: document.querySelector("#meterSummary"),
  nutritionMeters: document.querySelector("#nutritionMeters"),
  expertBackstory: document.querySelector("#expertBackstory"),
  benefitsList: document.querySelector("#benefitsList"),
  bestForList: document.querySelector("#bestForList"),
  starsText: document.querySelector("#starsText"),
  prosList: document.querySelector("#prosList"),
  consList: document.querySelector("#consList"),
  buyingAdvice: document.querySelector("#buyingAdvice"),
  searchResults: document.querySelector("#searchResults")
};

let latestPayload = null;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

function renderDefinitionList(node, data) {
  node.replaceChildren();

  for (const [key, value] of Object.entries(data || {})) {
    if (value == null || key === "notes") continue;
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = formatLabel(key);
    dd.textContent = stringifyListItem(value || "Unknown");
    node.append(dt, dd);
  }
}

function renderList(node, items) {
  node.replaceChildren();
  for (const item of items || []) {
    const li = document.createElement("li");
    li.textContent = stringifyListItem(item);
    node.append(li);
  }
}

function stringifyListItem(item) {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
    return String(item);
  }
  if (Array.isArray(item)) {
    return item.map(stringifyListItem).filter(Boolean).join("; ");
  }
  if (typeof item === "object") {
    const title = item.title || item.name || item.benefit || item.pro || item.con || item.point || item.label;
    const detail = item.detail || item.description || item.reason || item.explanation || item.note || item.value;
    if (title && detail) return `${title}: ${detail}`;
    if (title) return String(title);
    if (detail) return String(detail);
    return Object.entries(item)
      .map(([key, value]) => `${key}: ${stringifyListItem(value)}`)
      .join("; ");
  }
  return String(item);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatLabel(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function listHtml(items) {
  return `<ul>${(items || []).map((item) => `<li>${escapeHtml(stringifyListItem(item))}</li>`).join("")}</ul>`;
}

function detailsHtml(data) {
  return `<table class="details-table">${Object.entries(data || {})
    .filter(([key, value]) => value != null && key !== "notes")
    .map(([key, value]) => {
      const label = formatLabel(key);
      const text = stringifyListItem(value || "Unknown");
      return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(text)}</td></tr>`;
    })
    .join("")}</table>`;
}

function meterClass(status) {
  if (status === "good") return "good";
  if (status === "watch") return "watch";
  if (status === "low") return "low";
  return "ok";
}

function renderMeters(payload) {
  const nutritionValue = payload.nutritionValue || {};
  els.meterSummary.textContent = nutritionValue.summary || "";
  els.nutritionMeters.replaceChildren();

  for (const meter of nutritionValue.meters || []) {
    const value = Math.max(0, Math.min(100, Number(meter.value || 0)));
    const item = document.createElement("article");
    item.className = `meter-card ${meterClass(meter.status)}`;
    item.innerHTML = `
      <div class="meter-head">
        <strong>${meter.label || "Meter"}</strong>
        <span>${Math.round(value)}/100</span>
      </div>
      <div class="gauge" style="--value: ${value}">
        <div></div>
      </div>
      <small>${meter.note || ""}</small>
    `;
    els.nutritionMeters.append(item);
  }
}

function renderStars(stars) {
  const count = Math.max(0, Math.min(5, Math.round(Number(stars || 0))));
  return `${"*".repeat(count)}${"-".repeat(5 - count)} ${count}/5`;
}

function renderVerification(payload) {
  const verification = payload.verification || {};
  const verified = Boolean(verification.verified);
  const approximate = Boolean(verification.approximate || verification.passable);
  const statusText = verified ? "Verified: exact" : approximate ? "Verified: approximate" : "Verified: no";
  els.verificationStatus.textContent = statusText;
  els.verificationStatus.className = `verification-status ${verified ? "yes" : approximate ? "approx" : "no"}`;
  els.verificationFeedback.textContent =
    verification.feedback || payload.message || "No verification feedback available.";
  els.verificationAttempts.replaceChildren();

  for (const attempt of verification.attempts || []) {
    const item = document.createElement("article");
    const attemptApprox = Boolean(attempt.approximate || attempt.passable);
    item.className = `attempt ${attempt.verified ? "yes" : attemptApprox ? "approx" : "no"}`;
    item.innerHTML = `
      <strong>Attempt ${attempt.attempt}: ${attempt.verified ? "exact match" : attemptApprox ? "approx match" : "needs retry"}</strong>
      <span>${attempt.query || ""}</span>
      <small>${attempt.feedback || ""}</small>
    `;
    els.verificationAttempts.append(item);
  }
}

function renderResults(payload) {
  latestPayload = payload;
  els.downloadPdfButton.disabled = false;
  els.downloadHtmlButton.disabled = false;

  const health = payload.health || {};
  const product = payload.product || {};
  const nutrition = payload.nutrition || {};
  const search = payload.search || {};
  const benefits = payload.benefits || {};
  const review = payload.review || {};

  els.results.hidden = false;
  els.verdictText.textContent = health.verdict || "Unknown";
  els.scoreText.textContent = `${health.score ?? "?"}/100`;
  els.betterChoice.textContent = health.betterChoice || "";

  els.reasonsList.replaceChildren();
  for (const reason of health.reasons || []) {
    const li = document.createElement("li");
    li.textContent = reason;
    els.reasonsList.append(li);
  }

  renderDefinitionList(els.productDetails, product);
  renderDefinitionList(els.nutritionDetails, nutrition);
  renderVerification(payload);

  if (payload.blockedByVerification) {
    renderMeters({ nutritionValue: { summary: "Meters are paused until nutrition data is verified.", meters: [] } });
    els.expertBackstory.textContent = "Health-benefit agent did not run because verification failed.";
    renderList(els.benefitsList, []);
    renderList(els.bestForList, []);
    els.starsText.textContent = "-/5";
    renderList(els.prosList, []);
    renderList(els.consList, []);
    els.buyingAdvice.textContent = payload.message || "";
  } else {
    renderMeters(payload);
    els.expertBackstory.textContent = benefits.expertBackstory || "";
    renderList(els.benefitsList, benefits.benefits || []);
    renderList(els.bestForList, [
      ...(benefits.bestFor || []),
      ...(benefits.watchFor || []).map((item) => `Watch: ${stringifyListItem(item)}`)
    ]);
    els.starsText.textContent = renderStars(review.stars);
    renderList(els.prosList, review.pros || []);
    renderList(els.consList, review.cons || []);
    els.buyingAdvice.textContent = review.buyingAdvice || review.summary || "";
  }

  els.searchResults.replaceChildren();
  if (!search.configured) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = search.note || "Search is not configured.";
    els.searchResults.append(note);
  }

  for (const result of search.results || []) {
    const item = document.createElement("a");
    item.className = "search-item";
    item.href = result.link || "#";
    item.target = "_blank";
    item.rel = "noreferrer";
    item.innerHTML = `
      <strong>${result.title || "Result"}</strong>
      <span>${result.snippet || ""}</span>
    `;
    els.searchResults.append(item);
  }

  const openai = payload.configured?.openai ? "LLM on" : "LLM demo";
  const serper = payload.configured?.serper ? "Serper on" : "Serper off";
  els.configPill.textContent = `${openai} - ${serper}`;
}

function buildReportHtml(payload) {
  const product = payload.product || {};
  const nutrition = payload.nutrition || {};
  const nutritionValue = payload.nutritionValue || {};
  const health = payload.health || {};
  const benefits = payload.benefits || {};
  const review = payload.review || {};
  const image = payload.productImageUrl || "";
  const scoreValue = health.score ?? (review.stars ? review.stars * 20 : null);
  const score = scoreValue == null ? "Unknown" : `${scoreValue}/100`;
  const meters = (nutritionValue.meters || [])
    .map((meter) => {
      const value = Math.max(0, Math.min(100, Number(meter.value || 0)));
      return `
        <article class="meter">
          <div><strong>${escapeHtml(meter.label || "Meter")}</strong><span>${Math.round(value)}/100</span></div>
          <div class="bar" role="img" aria-label="${escapeHtml(meter.label || "Meter")} ${Math.round(value)} out of 100">
            <div class="fill" style="width:${value}%"></div>
          </div>
          <small>${escapeHtml(meter.note || "")}</small>
        </article>
      `;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(product.productName || "Food Health Report")}</title>
  <style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; padding: 28px; color: #16211c; font-family: Arial, sans-serif; background: #fff; }
    header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #dfe6e1; padding-bottom: 18px; }
    h1 { margin: 0; font-size: 30px; }
    h2 { margin: 0 0 12px; font-size: 19px; }
    p { margin: 0 0 10px; line-height: 1.45; }
    .muted { color: #66736d; }
    .hero { display: grid; grid-template-columns: 180px 1fr; gap: 20px; margin: 22px 0; }
    .hero img { width: 180px; height: 180px; object-fit: contain; border: 1px solid #dfe6e1; border-radius: 8px; }
    .card { break-inside: avoid; border: 1px solid #dfe6e1; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
    .details-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .details-table th, .details-table td { vertical-align: top; border-bottom: 1px solid #edf1ee; padding: 8px 6px; text-align: left; line-height: 1.35; }
    .details-table th { width: 190px; color: #16211c; font-weight: 700; overflow-wrap: anywhere; }
    .details-table td { color: #38443f; overflow-wrap: anywhere; }
    ul { margin: 0; padding-left: 20px; }
    li { margin-bottom: 7px; }
    .score { display: inline-block; border-radius: 999px; background: #0b8f64; color: #fff; padding: 9px 13px; font-weight: 700; }
    .meters { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .meter { border: 1px solid #dfe6e1; border-radius: 8px; padding: 12px; }
    .meter > div:first-child { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .bar { width: 100%; height: 13px; overflow: hidden; border: 1px solid #c7d2cc; border-radius: 999px; background: #e6ece8 !important; }
    .fill { height: 100%; min-width: 3px; border-radius: 999px; background: #0b8f64 !important; }
    .meter small { color: #66736d; display: block; margin-top: 7px; }
    footer { margin-top: 26px; border-top: 2px solid #dfe6e1; padding-top: 14px; text-align: center; font-weight: 700; }
    @media print { body { padding: 18px; } button { display: none; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Food Health Report</h1>
      <p class="muted">${escapeHtml(new Date(payload.generatedAt || Date.now()).toLocaleString())}</p>
    </div>
    <div class="score">Overall score: ${escapeHtml(score)}</div>
  </header>

  <section class="hero">
    ${image ? `<img src="${escapeHtml(image)}" alt="Product photo">` : `<div class="card muted">No product photo available</div>`}
    <div class="card">
      <h2>${escapeHtml(product.productName || "Product")}</h2>
      ${detailsHtml(product)}
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <h2>Nutrition Values</h2>
      ${detailsHtml(nutrition)}
    </div>
    <div class="card">
      <h2>Pros And Cons</h2>
      <p><strong>Stars:</strong> ${escapeHtml(renderStars(review.stars))}</p>
      <p><strong>Pros</strong></p>
      ${listHtml(review.pros || [])}
      <p><strong>Cons</strong></p>
      ${listHtml(review.cons || [])}
    </div>
  </section>

  <section class="card">
    <h2>Nutrition Meter Gauge</h2>
    <p class="muted">${escapeHtml(nutritionValue.summary || "")}</p>
    <div class="meters">${meters}</div>
  </section>

  <section class="card">
    <h2>Health Benefits</h2>
    ${listHtml(benefits.benefits || [])}
  </section>

  <section class="card">
    <h2>Overall Guidance</h2>
    <p>${escapeHtml(review.buyingAdvice || health.betterChoice || "")}</p>
    <p class="muted">${escapeHtml(health.disclaimer || benefits.disclaimer || "Informational only, not medical advice.")}</p>
  </section>

  <footer>---by kasoul Health system.</footer>
</body>
</html>`;
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function reportFilename(payload, extension) {
  const product = payload.product?.productName || "food-health-report";
  return `${product.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "food-health-report"}.${extension}`;
}

function openPdfReport() {
  if (!latestPayload) return;
  const html = buildReportHtml(latestPayload);
  const report = window.open("", "_blank");
  report.document.open();
  report.document.write(html);
  report.document.close();
  report.focus();
  setTimeout(() => report.print(), 500);
}

function downloadHtmlReport() {
  if (!latestPayload) return;
  downloadBlob(reportFilename(latestPayload, "html"), buildReportHtml(latestPayload), "text/html;charset=utf-8");
}

els.imageInput.addEventListener("change", () => {
  const [file] = els.imageInput.files;
  if (!file) return;

  const previewUrl = URL.createObjectURL(file);
  els.preview.src = previewUrl;
  els.preview.hidden = false;
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [file] = els.imageInput.files;
  const hint = els.hintInput.value.trim();
  if (!file && !hint) {
    els.statusText.textContent = "Choose an image or type a product name.";
    return;
  }

  els.analyzeButton.disabled = true;
  els.downloadPdfButton.disabled = true;
  els.downloadHtmlButton.disabled = true;
  latestPayload = null;
  els.statusText.textContent = file ? "Reading image and running agents..." : "Searching product text and running agents...";

  try {
    const imageDataUrl = file ? await fileToDataUrl(file) : "";
    const response = await fetch("/api/analyze-food", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        hint
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Analysis failed.");

    renderResults(payload);
    els.statusText.textContent = `Analysis complete at ${new Date(payload.generatedAt).toLocaleString()}.`;
  } catch (error) {
    els.statusText.textContent = error.message;
  } finally {
    els.analyzeButton.disabled = false;
  }
});

els.downloadPdfButton.addEventListener("click", openPdfReport);
els.downloadHtmlButton.addEventListener("click", downloadHtmlReport);

fetch("/api/health")
  .then((response) => {
    els.configPill.textContent = response.ok ? "Ready" : "Setup issue";
  })
  .catch(() => {
    els.configPill.textContent = "Server offline";
  });
