# Preserve the current cash-sync and OAuth implementation. Only its bounded
# GET performance function is patched; a source-function mismatch fails build.
FROM asia-east2-docker.pkg.dev/family-portfolio-gateway/cloud-run-source-deploy/family-portfolio-gateway@sha256:88d71cfeb76415c9830829f2e9003f031cfd0e336dd2d248b59888b8d0a0cad9
COPY cloud/xuan-preopen/gateway_classification_patch.py /app/gateway_classification_patch.py
RUN python /app/gateway_classification_patch.py
