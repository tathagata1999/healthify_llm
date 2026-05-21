import hashlib
import json
import os
import re
import sys
from pathlib import Path

import chromadb
from chromadb.utils import embedding_functions
from langchain_text_splitters import RecursiveCharacterTextSplitter


DB_DIR = Path(os.environ.get("CHROMA_DB_DIR", "chroma_db"))
RECORD_DIR = Path(os.environ.get("MEMORY_RECORD_DIR", "data/memory_records"))
COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "food_health_memory")
MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")


def slug(value):
    clean = re.sub(r"[^a-zA-Z0-9]+", "-", value or "food-product").strip("-").lower()
    return clean or "food-product"


def record_id_for(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def collection():
    DB_DIR.mkdir(parents=True, exist_ok=True)
    embedder = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=MODEL_NAME)
    client = chromadb.PersistentClient(path=str(DB_DIR))
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        embedding_function=embedder,
        metadata={"hnsw:space": "cosine"},
    )


def splitter():
    return RecursiveCharacterTextSplitter(
        chunk_size=900,
        chunk_overlap=120,
        separators=["\n\n", "\n", ". ", ", ", " ", ""],
    )


def write_record(record_id, record):
    RECORD_DIR.mkdir(parents=True, exist_ok=True)
    path = RECORD_DIR / f"{record_id}.json"
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def read_record(record_id):
    path = RECORD_DIR / f"{record_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def upsert(payload):
    text = payload.get("text") or ""
    query = payload.get("query") or ""
    product_name = payload.get("productName") or query or "food product"
    record = payload.get("record") or {}
    seed = f"{product_name}\n{query}\n{text}"
    record_id = record_id_for(seed)

    chunks = splitter().split_text(seed)
    if not chunks:
        chunks = [seed]

    ids = [f"{record_id}-{index}" for index in range(len(chunks))]
    metadatas = [
        {
            "record_id": record_id,
            "product_name": product_name,
            "brand": payload.get("brand") or "",
            "source": "health-app-analysis",
            "chunk": index,
        }
        for index in range(len(chunks))
    ]

    col = collection()
    col.upsert(ids=ids, documents=chunks, metadatas=metadatas)
    write_record(record_id, record)

    return {
        "ok": True,
        "record_id": record_id,
        "chunks": len(chunks),
        "model": MODEL_NAME,
        "collection": COLLECTION_NAME,
    }


def query(payload):
    query_text = payload.get("query") or ""
    min_score = float(payload.get("min_score", 0.72))
    n_results = int(payload.get("n_results", 3))
    if not query_text:
        return {"ok": False, "hit": False, "error": "Missing query"}

    col = collection()
    result = col.query(
        query_texts=[query_text],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )

    distances = result.get("distances", [[]])[0]
    metadatas = result.get("metadatas", [[]])[0]
    documents = result.get("documents", [[]])[0]
    if not distances or not metadatas:
        return {"ok": True, "hit": False, "results": []}

    candidates = []
    seen = set()
    for distance, metadata, document in zip(distances, metadatas, documents):
        record_id = metadata.get("record_id")
        if not record_id or record_id in seen:
            continue
        seen.add(record_id)
        score = max(0.0, 1.0 - float(distance))
        candidates.append(
            {
                "record_id": record_id,
                "score": score,
                "distance": float(distance),
                "product_name": metadata.get("product_name", ""),
                "document": document,
            }
        )

    best = candidates[0] if candidates else None
    if not best or best["score"] < min_score:
        return {"ok": True, "hit": False, "results": candidates, "min_score": min_score}

    return {
        "ok": True,
        "hit": True,
        "record": read_record(best["record_id"]),
        "best": best,
        "results": candidates,
        "min_score": min_score,
        "model": MODEL_NAME,
    }


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: vector_store.py <query|upsert>")

    payload = json.loads(sys.stdin.read() or "{}")
    command = sys.argv[1]
    if command == "query":
        output = query(payload)
    elif command == "upsert":
        output = upsert(payload)
    else:
        output = {"ok": False, "error": f"Unknown command: {command}"}

    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
