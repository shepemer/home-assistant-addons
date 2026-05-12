#!/usr/bin/with-contenv bashio

set -e

export NODE_ENV=production
export PORT=8099
export ADDON_OPTIONS_PATH=/data/options.json

bashio::log.info "Starting HomeScope on port ${PORT}"
exec node /app/dist/server/server.js

