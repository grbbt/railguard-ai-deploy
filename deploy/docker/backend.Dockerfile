# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

# XGBoost needs the OpenMP runtime; dependencies must install on the target CPU.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 railguard \
    && useradd --uid 10001 --gid railguard --no-create-home railguard
COPY requirements-lock.txt ./
RUN python -m pip install --no-cache-dir -r requirements-lock.txt

# The Dockerfile-specific ignore file restricts these trees to application code,
# reviewed Markdown, and exactly the active model/metadata files.
COPY backend/ ./backend/
COPY README.md ./
COPY docs/ ./docs/
COPY scripts/train_ps3.py ./scripts/train_ps3.py
COPY data/network/singapore-mrt.json ./data/network/singapore-mrt.json
COPY data/ps3_artifacts/ ./data/ps3_artifacts/
RUN mkdir -p /app/data/runtime /app/data/ps3 \
    && chown railguard:railguard /app/data/runtime

USER 10001:10001
EXPOSE 8000
# The in-process job queue requires one backend process.
CMD ["python", "-m", "uvicorn", "backend.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
