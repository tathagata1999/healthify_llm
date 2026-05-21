FROM node:22-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY requirements.txt ./

RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

COPY server.js ./
COPY public ./public
COPY data ./data
COPY scripts ./scripts
COPY README.md ./

ENV NODE_ENV=production
ENV PORT=7860
ENV MEMORY_ENABLED=true
ENV CHROMA_DB_DIR=/app/chroma_db
ENV MEMORY_RECORD_DIR=/app/data/memory_records

EXPOSE 7860

CMD ["node", "server.js"]
