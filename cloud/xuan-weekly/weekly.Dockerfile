FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/runtime && /opt/runtime/bin/pip install --no-cache-dir 'google-cloud-storage>=3.0,<4'
WORKDIR /app
COPY scripts/ ./scripts/
COPY claude/ ./claude/
COPY cloud/xuan-weekly/*.py ./cloud/xuan-weekly/
USER node
CMD ["/opt/runtime/bin/python", "cloud/xuan-weekly/weekly_job.py"]
