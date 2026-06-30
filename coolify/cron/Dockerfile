# Alpine cron sidecar. Replaces the three GitHub Actions cron triggers
# (scheduled-render, cleanup, needs-worker) with in-cluster crond hits
# against the dashboard's internal hostname.
#
# Stays in foreground so Docker doesn't think it died — `crond -f` runs
# the daemon in the foreground and logs to stderr (-d 8 = INFO level).

FROM alpine:3.20

RUN apk add --no-cache curl tzdata && \
    ln -sf /usr/share/zoneinfo/UTC /etc/localtime

# crontab format: m h dom mon dow command
COPY crontab /etc/crontabs/root
# Strip Windows line endings — cron is picky about them.
RUN sed -i 's/\r$//' /etc/crontabs/root && \
    chmod 600 /etc/crontabs/root

CMD ["crond", "-f", "-d", "8"]
