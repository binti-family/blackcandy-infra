#!/usr/bin/env bash

set -euo pipefail

CANDIDATE_NAME=$1
echo "Hi $CANDIDATE_NAME, let me get you up and running by authenticating!"

gcloud init --no-browser --skip-diagnostics
gcloud auth application-default login \
  --no-browser

CLUSTER="$(gcloud container clusters list --format=json | jq -r ".[0].name")"
gcloud container clusters get-credentials $CLUSTER --region=us-west1
kubectl config set-context --current --namespace="$CANDIDATE_NAME"

PULUMI_ACCESS_TOKEN=$(gcloud secrets versions access 1 --secret=$CANDIDATE_NAME) \
  pulumi login

npm install

pulumi stack init $CANDIDATE_NAME
pulumi stack select $CANDIDATE_NAME
cp Pulumi.template.yaml "Pulumi.${CANDIDATE_NAME}.yaml"