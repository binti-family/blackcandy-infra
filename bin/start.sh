#!/usr/bin/env bash

set -euo pipefail

npm install --immutable

docker run \
  --rm \
  -it \
  -w /home/candidate/blackcandy \
  -v="$(pwd):/home/candidate/blackcandy" \
  --entrypoint="" \
  --mount="source=node_env,target=/home/candidate/blackcandy/node_modules" \
   docker.io/bintieng/devops-candidate-env:latest /bin/bash
