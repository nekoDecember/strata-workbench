FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS python-base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MPLBACKEND=Agg \
    OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 POLARS_MAX_THREADS=4
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY pyproject.toml ./
COPY LICENSE THIRD_PARTY.md THIRD_PARTY_LICENSES.txt ./
COPY strata/ ./strata/
RUN pip install --no-cache-dir --no-deps . && \
    useradd --uid 1000 --create-home strata && \
    mkdir -p /data /jobs /notebooks && chown -R strata:strata /data /jobs /notebooks
USER strata

FROM python-base AS app
COPY --from=frontend /build/dist /app/frontend/dist
EXPOSE 8080
CMD ["uvicorn", "strata.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]

FROM python-base AS worker
CMD ["python", "-m", "strata.worker"]

FROM python-base AS notebook
USER root
COPY requirements-notebook.lock ./
RUN pip install --no-cache-dir -r requirements-notebook.lock
COPY notebooks/ /notebooks/
COPY scripts/start_notebook.py /app/start_notebook.py
RUN chown -R strata:strata /notebooks
USER strata
EXPOSE 8888
CMD ["python", "/app/start_notebook.py"]
