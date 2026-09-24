#!/bin/sh
set -e

cd /app
exec npx tsx packages/server/src/server.ts
