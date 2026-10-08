# Build from the repository root:  docker build -f python-executor/Dockerfile -t openharness-python-executor .
# Python 3.12 with the data and trading libraries agent code may use (python-executor/requirements.txt), the
# trusted runner (runner.py, oh.py) and the HTTP mode for Compose (service.py).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY python-executor/requirements.txt /opt/executor/requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: -r /opt/executor/requirements.txt \
  || pip install --no-cache-dir -r /opt/executor/requirements.txt
COPY python-executor/runner.py python-executor/oh.py python-executor/service.py /opt/executor/
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin executor \
  && mkdir -p /work && chown executor:executor /work
USER executor
WORKDIR /work
ENV OH_WORKDIR=/work EXECUTOR_WORK_ROOT=/work
EXPOSE 7000
# One-shot job (Kubernetes): `python /opt/executor/runner.py`; the service is for Compose.
CMD ["python", "/opt/executor/service.py"]
