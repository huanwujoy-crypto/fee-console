# Official Python runtime digest read from Docker Hub on 2026-10-14.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y tzdata \
    && rm -rf /var/lib/apt/lists/*
COPY clock.py runtime.py benchmark.py benchmark-calendar.json /app/
RUN useradd --uid 10001 --create-home clock
USER 10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 FEE_CLOCK_ENABLED=false FEE_BENCHMARK_CLOCK_ENABLED=false
ENTRYPOINT ["python", "/app/runtime.py"]
