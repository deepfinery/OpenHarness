# An isolated fake VM root for privileged connector tests. Never mount the Docker host root or PID namespace.
FROM alpine:3.22
RUN printf '#!/bin/sh\necho "FIXTURE NVIDIA telemetry"\n' > /usr/bin/nvidia-smi && \
    printf '#!/bin/sh\necho "FIXTURE DCGM telemetry"\n' > /usr/bin/dcgmi && \
    chmod 755 /usr/bin/nvidia-smi /usr/bin/dcgmi && \
    echo 'isolated target filesystem' > /target-only-proof
CMD ["sleep", "infinity"]
