#!/bin/sh
# Wrap app.html into a full standalone index.html (the artifact host adds this skeleton itself).
cd "$(dirname "$0")"
{ printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'; cat app.html; printf '\n</body></html>\n'; } > index.html
