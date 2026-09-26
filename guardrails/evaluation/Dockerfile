FROM python:3.12.12-slim
ENV DO_NOT_TRACK=1 NEMO_GUARDRAILS_NO_USAGE_STATS=1 HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_OFFLINE=1 OTEL_SDK_DISABLED=true PYTHONDONTWRITEBYTECODE=1 XDG_DATA_HOME=/tmp/garak XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache
# Only the packaged PromptInject data/generator are used; no model adapters or downloaded datasets.
RUN pip install --no-cache-dir --no-deps garak==0.17.0 && pip install --no-cache-dir PyYAML==6.0.3 xdg-base-dirs==6.0.2
COPY guardrails/evaluation/server.py /opt/server.py
RUN useradd --create-home --uid 10001 evaluator
USER evaluator
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')"
CMD ["python", "/opt/server.py"]
