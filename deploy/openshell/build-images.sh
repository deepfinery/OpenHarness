#!/bin/sh
# Builds the two images this deployment uses from a checkout of the repository, on the OpenShell host itself so
# the Docker driver can use the executor image without a registry. Run from anywhere:
#   sh deploy/openshell/build-images.sh [tag]
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
tag="${1:-local}"
docker build -f connector-go/Dockerfile -t "openharness-connector:$tag" .
docker build -f connector-go/Dockerfile --target edge -t "openharness-edge:$tag" .
echo "Built openharness-connector:$tag and openharness-edge:$tag. Set EXECUTOR_IMAGE and EDGE_IMAGE in deploy/openshell/.env if you used another tag."
