FROM nginx:1.30.5-alpine

RUN apk upgrade --no-cache && apk add --no-cache openssl && rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/conf.d/
COPY entrypoint.sh /entrypoint.sh
COPY activate-production-tls.sh /activate-production-tls.sh

RUN chmod +x /entrypoint.sh /activate-production-tls.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
