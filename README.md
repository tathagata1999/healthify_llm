Access Link: https://huggingface.co/spaces/Tatha1999/health_benefit_app
---
title: Food Health Scanner
emoji: 🥗
colorFrom: green
colorTo: blue
sdk: docker
pinned: false
license: mit
---

# Food Health Scanner

A Gradio app that lets a user upload a food/product image or search by product name, identifies the product, searches the web for nutrition evidence, and passes the result through multiple nutrition agents.

The Hugging Face Space serves Gradio on port `7860`. The existing Node analysis API runs privately inside the container on `NODE_API_PORT` and keeps the agent workflow, OpenAI tracing metadata, Serper search, report generation data, and ChromaDB memory logic.

## Flow

1. User uploads a packaged food, fruit, juice, snack, or other food image, or types a product name.
2. Vision agent extracts product details from an image, or text mode parses the typed product name.
3. Search agent queries nutrition evidence using a Google Serper-compatible API.
4. Nutrition agent extracts calories/macros/ingredients from evidence.
5. Verification agent checks the nutrition against web evidence and gives feedback if data is weak or conflicting.
6. If values are close enough but not exact, the verifier marks them `approximate`/`passable`, and downstream agents run with approximate labels.
7. Search/nutrition retry loop runs again with a refined query until exact, approximate/passable, or the max attempt limit is reached.
8. Nutrition-value agent converts verified or approximate evidence into meter gauges.
9. Health-benefit expert agent explains likely benefits with careful professional nutrition guidance.
10. Pros/cons review agent gives balanced pros, cons, and a 1-5 star rating.
11. Report generator creates a print-ready PDF report and a downloadable HTML fallback with photo, nutrition gauges, pros, cons, benefits, overall score, and footer.
12. Memory layer stores relevant analysis data in ChromaDB for future RAG or fine-tuning datasets.

## Memory / RAG

The app includes an optional ChromaDB memory layer:

- Embedding model: `all-MiniLM-L6-v2`
- Vector DB: ChromaDB persistent collection `food_health_memory`
- Chunking: `RecursiveCharacterTextSplitter`
- Full analysis records: `data/memory_records`

Search flow:

```text
User query -> ChromaDB RAG lookup
  -> if strong match exists: return stored analysis
  -> if not: Serper web search + LLM agents
  -> store completed analysis back into ChromaDB
```

Useful environment variables:

```text
MEMORY_ENABLED=true
MEMORY_MIN_SCORE=0.72
CHROMA_DB_DIR=chroma_db
MEMORY_RECORD_DIR=data/memory_records
EMBEDDING_MODEL=all-MiniLM-L6-v2
```

Install local Python dependencies if you want memory outside Docker:

```powershell
pip install -r requirements.txt
```

## Run The Original Local Web App

```powershell
node server.js
```

Open:

```text
http://localhost:4173
```

On Hugging Face Spaces, the Docker runtime uses port `7860` automatically.

## Run The Gradio App

```powershell
pip install -r requirements.txt
python app.py
```

Open:

```text
http://localhost:7860
```

`app.py` starts the Node analysis backend internally on `NODE_API_PORT` and exposes the Gradio interface on `7860`.

## API keys

The app works in demo mode without keys. For real analysis, set:

```powershell
$env:OPENAI_API_KEY="your_openai_key"
$env:OPENAI_MODEL="gpt-4o-mini"
$env:SERPER_API_KEY="your_serper_key"
node server.js
```

For Hugging Face Spaces, add these in **Settings → Secrets and variables → Secrets**:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` such as `gpt-4o-mini`
- `SERPER_API_KEY`

If you want ChromaDB memory to survive Space rebuilds/restarts, enable persistent storage for the Space or mount storage to `CHROMA_DB_DIR` and `MEMORY_RECORD_DIR`.

`SERPER_API_KEY` maps to the same service used by LangChain's Python utility:

```python
from langchain_community.utilities import GoogleSerperAPIWrapper
```

This app calls Serper directly from Node so no Python dependencies are required.

## Endpoint

- `POST /api/analyze-food`

Payload:

```json
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "hint": "optional or text-only product name"
}
```

Response contains:

- `product`
- `search`
- `nutrition`
- `verification`
- `nutritionValue`
- `health`
- `benefits`
- `review`
- `productImageUrl`

## Reports

After an analysis completes, use:

- **Download PDF report** to open a print-ready report and save it as PDF from the browser print dialog.
- **Download HTML report** to download a standalone report file directly.

For text-only searches, the app uses Serper image search to pick a product photo from the web when available. Uploaded images are used directly in the report.

## Note

The health verdict is informational only and not medical advice. Real nutrition quality depends on serving size, full label visibility, ingredients, allergies, medical conditions, and personal diet goals.
