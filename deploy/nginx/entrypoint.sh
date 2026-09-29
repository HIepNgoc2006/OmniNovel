#!/bin/sh
set -e

DOMAIN="${DOMAIN:-localhost}"
CERT_DIR="/etc/nginx/ssl"
DUMMY_DIR="${CERT_DIR}/dummy"
LIVE_DIR="${CERT_DIR}/live/${DOMAIN}"
CURRENT_DIR="${CERT_DIR}/current"
RUNTIME_DIR="/etc/nginx/runtime"

mkdir -p "${DUMMY_DIR}" "${CURRENT_DIR}" "${RUNTIME_DIR}"

if [ ! -f "${DUMMY_DIR}/cert.pem" ] || [ ! -f "${DUMMY_DIR}/key.pem" ]; then
  echo "[Nginx Entrypoint] Đang sinh chứng chỉ Self-Signed Bootstrap..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
    -keyout "${DUMMY_DIR}/key.pem" \
    -out "${DUMMY_DIR}/cert.pem" \
    -subj "/CN=${DOMAIN}"
fi

if [ -f "${LIVE_DIR}/fullchain.pem" ] && [ -f "${LIVE_DIR}/privkey.pem" ]; then
  echo "[Nginx Entrypoint] Kích hoạt PRODUCTION TLS State cho domain: ${DOMAIN}."
  ln -sfn "${LIVE_DIR}/fullchain.pem" "${CURRENT_DIR}/fullchain.pem"
  ln -sfn "${LIVE_DIR}/privkey.pem" "${CURRENT_DIR}/privkey.pem"

  cat << 'EOF' > "${RUNTIME_DIR}/tls-mode.conf"
# PRODUCTION MODE: HSTS enabled
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
EOF

  cat << 'EOF' > "${RUNTIME_DIR}/port80-mode.conf"
# PRODUCTION MODE: Redirect all HTTP to HTTPS
location / {
    return 301 https://$host$request_uri;
}
EOF

else
  echo "[Nginx Entrypoint] Kích hoạt BOOTSTRAP TLS State (Self-signed, No HSTS)."
  ln -sfn "${DUMMY_DIR}/cert.pem" "${CURRENT_DIR}/fullchain.pem"
  ln -sfn "${DUMMY_DIR}/key.pem" "${CURRENT_DIR}/privkey.pem"

  cat << 'EOF' > "${RUNTIME_DIR}/tls-mode.conf"
# BOOTSTRAP MODE: HSTS is disabled to prevent browser pinning
EOF

  cat << 'EOF' > "${RUNTIME_DIR}/port80-mode.conf"
# BOOTSTRAP MODE: Allow direct HTTP proxy during setup
location / {
    proxy_pass http://api_backend;
}
EOF
fi

nginx -t

if [ $# -gt 0 ]; then
  exec "$@"
fi

exec nginx -g "daemon off;"
