#!/usr/bin/env bash
# Read-only verification for the manager refresh plan (B0 and post-deploy).
# Run by the coordinator with existing read access. It only describes and
# reads IAM policy metadata; it never reads a secret value, never creates,
# updates, deletes, deploys or executes anything. Missing resources are
# reported, not created. Usage: verify-readonly.sh [acceptance|production|all]
set -uo pipefail
P=family-portfolio-gateway
R=asia-east2
which="${1:-all}"

run() { echo "## $*"; "$@" 2>&1 | sed -e 's/^/   /'; echo; }

common() {
  run gcloud iam roles describe roles/run.invoker --format='value(includedPermissions)'
  run gcloud run jobs describe fee-clock-launch --project="$P" --region="$R" --format='value(metadata.name)'
}

env_checks() {
  local suffix="$1" sa="$2"
  for b in queue ledger status; do
    run gcloud storage buckets describe "gs://family-portfolio-gateway-fee-refresh-${b}${suffix}" --format='yaml(name,lifecycle_config,iam_configuration,public_access_prevention,soft_delete_policy)'
    run gcloud storage buckets get-iam-policy "gs://family-portfolio-gateway-fee-refresh-${b}${suffix}"
  done
  for a in intake launch; do
    run gcloud iam service-accounts describe "fee-refresh-${a}${sa}@${P}.iam.gserviceaccount.com" --project="$P"
  done
  run gcloud run jobs describe "fee-refresh-launch${suffix}" --project="$P" --region="$R" --format=yaml
  run gcloud run jobs get-iam-policy "fee-refresh-launch${suffix}" --project="$P" --region="$R"
  run gcloud run services describe "fee-refresh-intake${suffix}" --project="$P" --region="$R" --format=yaml
  run gcloud run services get-iam-policy "fee-refresh-intake${suffix}" --project="$P" --region="$R"
}

common
case "$which" in
  acceptance) env_checks -acceptance -acc ;;
  production) env_checks "" ""; run gcloud secrets describe fee-refresh-github-actions --project="$P"; run gcloud secrets get-iam-policy fee-refresh-github-actions --project="$P" ;;
  all) env_checks -acceptance -acc; env_checks "" ""; run gcloud secrets describe fee-refresh-github-actions --project="$P"; run gcloud secrets get-iam-policy fee-refresh-github-actions --project="$P" ;;
  *) echo "usage: $0 [acceptance|production|all]" >&2; exit 2 ;;
esac
