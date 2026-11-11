#!/bin/sh
# Wrap app.html into a full standalone index.html (the artifact host adds this skeleton itself).
cd "$(dirname "$0")"
{ printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  printf '<link rel="icon" href="icons/favicon.svg" type="image/svg+xml"><link rel="icon" href="icons/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="icons/apple-touch-icon.png"><link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#EFEBE4" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#141A16" media="(prefers-color-scheme: dark)">'
  printf '</head><body>\n'; cat app.html; printf '\n</body></html>\n'; } > index.html
