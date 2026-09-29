#!/bin/sh
set -e

DOMAIN="${DOMAIN:-localhost}"
CERT_DIR="/etc/nginx/ssl"
LIVE_DIR="${CERT_DIR}/live/${DOMAIN}"
CURRENT_DIR="${CERT_DIR}/current"
RUNTIME_DIR="/etc/nginx/runtime"

if [ ! -f "${LIVE_DIR}/fullchain.pem" ] || [ ! -f "${LIVE_DIR}/privkey.pem" ]; then
  echo "ERROR: Không tìm thấy chứng chỉ Let's Encrypt tại ${LIVE_DIR}"
  exit 1
fi

echo "Đang kích hoạt chứng chỉ Production Let's Encrypt cho domain: ${DOMAIN}..."

ln -sfn "${LIVE_DIR}/fullchain.pem" "${CURRENT_DIR}/fullchain.pem"
ln -sfn "${LIVE_DIR}/privkey.pem" "${CURRENT_DIR}/privkey.pem"

cat << 'EOF' > "${RUNTIME_DIR}/tls-mode.conf"
# PRODUCTION MODE: HSTS enabled
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
EOF

cat << 'EOF' > "${RUNTIME_DIR}/port80-mode.conf"
# PRODUCTION MODE: Redirect all HTTP to HTTPS (trừ ACME challenge)
location / {
    return 301 https://$host$request_uri;
}
EOF

nginx -t
nginx -s reload

echo "Kích hoạt Production TLS thành công không gián đoạn dịch vụ!"
