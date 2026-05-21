import base64
import html
import json
import mimetypes
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

import gradio as gr
import requests


ROOT = Path(__file__).resolve().parent
NODE_API_PORT = int(os.environ.get("NODE_API_PORT", "4174"))
NODE_API_BASE = f"http://127.0.0.1:{NODE_API_PORT}"
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("ANALYSIS_TIMEOUT_SECONDS", "240"))


def start_node_backend():
    env = os.environ.copy()
    env["PORT"] = str(NODE_API_PORT)
    process = subprocess.Popen(
        ["node", "server.js"],
        cwd=ROOT,
        env=env,
    )

    deadline = time.time() + 35
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError("The Node analysis backend stopped during startup.")
        try:
            response = requests.get(f"{NODE_API_BASE}/api/health", timeout=2)
            if response.ok:
                return process
        except requests.RequestException:
            time.sleep(0.5)

    raise RuntimeError("The Node analysis backend did not become ready in time.")


BACKEND_PROCESS = start_node_backend()


def encode_image(image_path):
    if not image_path:
        return ""
    path = Path(image_path)
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    payload = base64.b64encode(path.read_bytes()).decode("utf-8")
    return f"data:{mime};base64,{payload}"


def clean_filename(name):
    value = re.sub(r"[^a-zA-Z0-9]+", "-", name or "food-health-report").strip("-").lower()
    return value or "food-health-report"


def stringify(value):
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "; ".join(filter(None, (stringify(item) for item in value)))
    if isinstance(value, dict):
        title = value.get("title") or value.get("name") or value.get("benefit") or value.get("pro")
        title = title or value.get("con") or value.get("point") or value.get("label")
        detail = value.get("detail") or value.get("description") or value.get("reason")
        detail = detail or value.get("explanation") or value.get("note") or value.get("value")
        if title and detail:
            return f"{title}: {detail}"
        if title:
            return str(title)
        if detail:
            return str(detail)
        return "; ".join(f"{key}: {stringify(item)}" for key, item in value.items())
    return str(value)


def labelize(key):
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(key).replace("_", " "))
    return text.strip().title()


def list_markdown(items):
    values = [stringify(item) for item in (items or [])]
    values = [item for item in values if item]
    if not values:
        return "_No details available._"
    return "\n".join(f"- {item}" for item in values)


def details_table(data):
    rows = []
    for key, value in (data or {}).items():
        if value is None or key == "notes":
            continue
        rows.append(f"| {labelize(key)} | {stringify(value)} |")
    if not rows:
        return "_No details available._"
    return "| Field | Value |\n|---|---|\n" + "\n".join(rows)


def star_text(stars):
    try:
        count = max(0, min(5, round(float(stars))))
    except (TypeError, ValueError):
        count = 0
    return f"{'*' * count}{'-' * (5 - count)} {count}/5"


def gauge_html(payload):
    nutrition_value = payload.get("nutritionValue") or {}
    meters = nutrition_value.get("meters") or []
    cards = []
    for meter in meters:
        try:
            value = max(0, min(100, float(meter.get("value") or 0)))
        except (TypeError, ValueError):
            value = 0
        label = html.escape(str(meter.get("label") or "Meter"))
        note = html.escape(str(meter.get("note") or ""))
        cards.append(
            f"""
            <article class="meter-card">
              <div class="meter-head"><strong>{label}</strong><span>{round(value)}/100</span></div>
              <div class="meter-bar"><div style="width:{value}%"></div></div>
              <small>{note}</small>
            </article>
            """
        )

    summary = html.escape(str(nutrition_value.get("summary") or ""))
    return f"""
    <style>
      .meter-grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }}
      .meter-card {{ border:1px solid #d8e2dc; border-radius:8px; padding:12px; background:#ffffff; }}
      .meter-head {{ display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; color:#17231d; }}
      .meter-bar {{ height:14px; border-radius:999px; background:#e6eee9; border:1px solid #c9d7cf; overflow:hidden; }}
      .meter-bar > div {{ height:100%; background:#0b8f64; border-radius:999px; }}
      .meter-card small {{ display:block; margin-top:7px; color:#5f6d67; }}
    </style>
    <p>{summary}</p>
    <div class="meter-grid">{''.join(cards) or '<p>No gauge data available.</p>'}</div>
    """


def report_html(payload):
    product = payload.get("product") or {}
    nutrition = payload.get("nutrition") or {}
    health = payload.get("health") or {}
    benefits = payload.get("benefits") or {}
    review = payload.get("review") or {}
    image = payload.get("productImageUrl") or ""
    product_name = html.escape(str(product.get("productName") or "Product"))
    score = health.get("score")
    if score is None and review.get("stars") is not None:
        try:
            score = round(float(review.get("stars")) * 20)
        except (TypeError, ValueError):
            score = None
    score_text = "Unknown" if score is None else f"{score}/100"

    def table(data):
        body = []
        for key, value in (data or {}).items():
            if value is None or key == "notes":
                continue
            body.append(
                f"<tr><th>{html.escape(labelize(key))}</th><td>{html.escape(stringify(value))}</td></tr>"
            )
        return f"<table>{''.join(body)}</table>" if body else "<p>No details available.</p>"

    def bullets(items):
        values = [html.escape(stringify(item)) for item in (items or []) if stringify(item)]
        return f"<ul>{''.join(f'<li>{item}</li>' for item in values)}</ul>" if values else "<p>No details available.</p>"

    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{product_name} Health Report</title>
  <style>
    * {{ box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
    body {{ margin:0; padding:28px; font-family:Arial,sans-serif; color:#17231d; background:#fff; }}
    header {{ display:flex; justify-content:space-between; gap:24px; border-bottom:2px solid #dfe8e2; padding-bottom:18px; }}
    h1 {{ margin:0; font-size:30px; }}
    h2 {{ margin:0 0 12px; font-size:19px; }}
    p {{ line-height:1.45; }}
    .score {{ align-self:flex-start; border-radius:999px; background:#0b8f64; color:#fff; padding:9px 13px; font-weight:700; }}
    .hero {{ display:grid; grid-template-columns:180px 1fr; gap:20px; margin:22px 0; }}
    img {{ width:180px; height:180px; object-fit:contain; border:1px solid #dfe8e2; border-radius:8px; }}
    .card {{ break-inside:avoid; border:1px solid #dfe8e2; border-radius:8px; padding:16px; margin-bottom:14px; }}
    .grid {{ display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }}
    table {{ width:100%; border-collapse:collapse; table-layout:fixed; }}
    th, td {{ border-bottom:1px solid #edf2ef; padding:8px 6px; text-align:left; vertical-align:top; overflow-wrap:anywhere; line-height:1.35; }}
    th {{ width:190px; }}
    footer {{ margin-top:26px; border-top:2px solid #dfe8e2; padding-top:14px; text-align:center; font-weight:700; }}
  </style>
</head>
<body>
  <header><div><h1>Food Health Report</h1><p>{product_name}</p></div><div class="score">Overall score: {html.escape(score_text)}</div></header>
  <section class="hero">{f'<img src="{html.escape(image)}" alt="Product photo">' if image else '<div class="card">No product photo available</div>'}<div class="card"><h2>Product</h2>{table(product)}</div></section>
  <section class="grid"><div class="card"><h2>Nutrition</h2>{table(nutrition)}</div><div class="card"><h2>Pros And Cons</h2><p><strong>Stars:</strong> {html.escape(star_text(review.get("stars")))}</p><p><strong>Pros</strong></p>{bullets(review.get("pros"))}<p><strong>Cons</strong></p>{bullets(review.get("cons"))}</div></section>
  <section class="card"><h2>Nutrition Gauge</h2>{gauge_html(payload)}</section>
  <section class="card"><h2>Health Benefits</h2>{bullets(benefits.get("benefits"))}</section>
  <section class="card"><h2>Overall Guidance</h2><p>{html.escape(stringify(review.get("buyingAdvice") or health.get("betterChoice") or ""))}</p></section>
  <footer>---by kasoul Health system.</footer>
</body>
</html>"""


def make_report_file(payload):
    product_name = ((payload.get("product") or {}).get("productName") or "food-health-report")
    filename = clean_filename(product_name) + ".html"
    path = Path(tempfile.gettempdir()) / filename
    path.write_text(report_html(payload), encoding="utf-8")
    return str(path)


def backend_health():
    try:
        response = requests.get(f"{NODE_API_BASE}/api/health", timeout=5)
        response.raise_for_status()
        status = response.json()
    except Exception as exc:
        return f"Backend is not reachable: {exc}"

    openai = "configured" if status.get("openaiConfigured") else "missing"
    serper = "configured" if status.get("serperConfigured") else "missing"
    memory = "enabled" if status.get("memoryEnabled") else "disabled"
    model = status.get("model") or "not set"

    notes = []
    if openai == "missing":
        notes.append("Add OPENAI_API_KEY in Hugging Face Space Settings -> Secrets.")
    if serper == "missing":
        notes.append("Add SERPER_API_KEY in Hugging Face Space Settings -> Secrets.")
    if not notes:
        notes.append("Secrets look ready. If analysis is still slow, wait for the first cold start to finish.")

    return f"""### System Status

| Check | Status |
|---|---|
| OpenAI key | {openai} |
| Serper key | {serper} |
| Model | {model} |
| Memory | {memory} |

{chr(10).join(f"- {note}" for note in notes)}
"""


def analyze_food(image_path, product_text):
    product_text = (product_text or "").strip()
    if not image_path and not product_text:
        message = "Upload a food image or type a product name first."
        return message, "", {}, {}, "", "", {}, None

    try:
        response = requests.post(
            f"{NODE_API_BASE}/api/analyze-food",
            json={"imageDataUrl": encode_image(image_path), "hint": product_text},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        try:
            payload = response.json()
        except ValueError:
            raise RuntimeError(f"Backend returned non-JSON response: HTTP {response.status_code}")
        if not response.ok:
            raise RuntimeError(payload.get("error") or "Analysis failed.")
    except Exception as exc:
        message = f"Analysis failed: {exc}"
        return message, "", {}, {}, "", "", {}, None

    product = payload.get("product") or {}
    health = payload.get("health") or {}
    verification = payload.get("verification") or {}
    benefits = payload.get("benefits") or {}
    review = payload.get("review") or {}

    status = "exact" if verification.get("verified") else "approximate" if verification.get("approximate") or verification.get("passable") else "not verified"
    trace = payload.get("traceId") or "not available"
    memory = "memory hit" if payload.get("memoryHit") else "fresh web/agent run"

    summary = f"""### {product.get('productName') or 'Food product'}

**Verdict:** {health.get('verdict') or 'Unknown'}  
**Score:** {health.get('score', '?')}/100  
**Verification:** {status}  
**Source:** {memory}  
**Trace:** `{trace}`

{health.get('betterChoice') or ''}
"""
    benefits_md = f"""### Health Benefits
{list_markdown(benefits.get('benefits'))}

### Best For / Watch For
{list_markdown((benefits.get('bestFor') or []) + [f"Watch: {stringify(item)}" for item in (benefits.get('watchFor') or [])])}
"""
    review_md = f"""### Pros
{list_markdown(review.get('pros'))}

### Cons
{list_markdown(review.get('cons'))}

**Rating:** {star_text(review.get('stars'))}

{review.get('buyingAdvice') or review.get('summary') or ''}
"""
    verification_md = f"""### Verification Feedback
{verification.get('feedback') or payload.get('message') or 'No verification feedback available.'}

### Product Details
{details_table(product)}

### Nutrition Details
{details_table(payload.get('nutrition') or {})}
"""
    return (
        summary,
        gauge_html(payload),
        product,
        payload.get("nutrition") or {},
        verification_md,
        benefits_md,
        review_md,
        make_report_file(payload),
    )


with gr.Blocks(title="Food Health Scanner", theme=gr.themes.Soft(primary_hue="green")) as demo:
    gr.Markdown(
        """
        # Food Health Scanner
        Upload a food photo or search by product name. The app checks web evidence, validates nutrition data, builds health gauges, and creates a downloadable report.
        """
    )

    status_output = gr.Markdown(value=backend_health())
    refresh_status = gr.Button("Refresh system status")

    with gr.Row():
        with gr.Column(scale=1):
            image_input = gr.Image(type="filepath", label="Food or product image")
            text_input = gr.Textbox(label="Product name or extra clue", placeholder="Example: Farmley Panchmeva")
            submit = gr.Button("Analyze", variant="primary")
        with gr.Column(scale=2):
            summary_output = gr.Markdown(label="Summary")
            gauge_output = gr.HTML(label="Nutrition Gauge")

    with gr.Tab("Details"):
        with gr.Row():
            product_output = gr.JSON(label="Product")
            nutrition_output = gr.JSON(label="Nutrition")
        verification_output = gr.Markdown(label="Verification")

    with gr.Tab("Health Review"):
        benefits_output = gr.Markdown(label="Benefits")
        review_output = gr.Markdown(label="Pros, Cons, Rating")

    report_output = gr.File(label="Download HTML report")

    refresh_status.click(backend_health, inputs=[], outputs=[status_output])

    submit.click(
        analyze_food,
        inputs=[image_input, text_input],
        outputs=[
            summary_output,
            gauge_output,
            product_output,
            nutrition_output,
            verification_output,
            benefits_output,
            review_output,
            report_output,
        ],
    )


if __name__ == "__main__":
    demo.queue(default_concurrency_limit=2).launch(server_name="0.0.0.0", server_port=7860)
