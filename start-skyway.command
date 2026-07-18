#!/bin/sh
# =====================================================================
#  Skyway Dispatch Console - local launcher (macOS / Linux)
#  macOS: double-click this file (you may need: chmod +x start-skyway.command).
#  Linux: run  ./start-skyway.command  (or  sh start-skyway.command ).
#  Serving over http://localhost (NOT file://) is what makes the Google
#  Maps API key work and keeps your data stable.
# =====================================================================
cd "$(dirname "$0")" || exit 1
URL="http://localhost:8080/index.html"
echo ""
echo "  Skyway Dispatch Console"
echo "  Opening $URL ..."
echo "  (Keep this window open while you use the app. Press Ctrl+C to stop.)"
echo ""
( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) &
if command -v python3 >/dev/null 2>&1; then exec python3 -m http.server 8080
elif command -v python >/dev/null 2>&1; then exec python -m http.server 8080
elif command -v npx >/dev/null 2>&1; then exec npx --yes http-server -p 8080 -c-1
else
  echo "  Could not find Python or Node."
  echo "  Install Python from https://www.python.org/downloads/ and run this again."
  read -r _
fi
