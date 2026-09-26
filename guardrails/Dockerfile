FROM python:3.12.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    NEMO_GUARDRAILS_NO_USAGE_STATS=1 DO_NOT_TRACK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    OTEL_SDK_DISABLED=true LANGCHAIN_TRACING_V2=false
WORKDIR /opt/guardrails
COPY guardrails/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 rails
COPY guardrails/config /config
USER rails
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/v1/health', timeout=3)"
CMD ["nemoguardrails", "server", "--config=/config", "--port=8000", "--disable-chat-ui"]
