FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir 'google-cloud-storage>=3.0,<4'
COPY ib_source.py source_job.py /app/
RUN useradd --uid 10001 --create-home worker
USER 10001
CMD ["python", "source_job.py"]
