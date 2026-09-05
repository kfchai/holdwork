#!/usr/bin/env bash
# Publish sections 1..6 in order, retrying each every minute until the 30-minute window allows it.
cd "$(dirname "$0")/.." || exit 1
for n in 1 2 3 4 5 6; do
  until npx tsx scripts/moltbook-post.ts post "$n" >> .moltbook-post-all.log 2>&1; do
    sleep 60
  done
  echo "$(date -u +%FT%TZ) posted section $n" >> .moltbook-post-all.log
done
echo "$(date -u +%FT%TZ) all sections posted" >> .moltbook-post-all.log
