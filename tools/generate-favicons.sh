#!/usr/bin/env bash
#
# Generate the complete Chirpy v7.6.0 favicon set from a master PNG.
#
# Requirement: ImageMagick 7 (magick / identify)
#
# Usage: See help information

set -eu

# --- Variables (defaults) ---
OUT_DIR="assets/img/favicons"
SRC=""

# Output filenames — the EXACT 7 Chirpy v7.6.0 names (do NOT rename; the gem's
# _includes/favicons.html hardcodes these paths). This script emits the 6 BINARY
# icons only; site.webmanifest is hand-edited separately (2-line color override).
FAV_ICO="favicon.ico"
FAV_96="favicon-96x96.png"
FAV_SVG="favicon.svg"
APPLE="apple-touch-icon.png"
MANIFEST_192="web-app-manifest-192x192.png"
MANIFEST_512="web-app-manifest-512x512.png"
CENTERED="_centered.png" # private intermediate, deleted at end

help() {
  echo "Generate the Chirpy v7.6.0 favicon set (6 binary icons) from a master PNG."
  echo
  echo "Usage:"
  echo
  echo "   bash $0 [<source.png>] [options]"
  echo
  echo "Options:"
  echo "     -o, --output <out_dir>    Output directory (default: assets/img/favicons)."
  echo "     -h, --help                Print this help information."
  echo
  echo "Arguments:"
  echo "     <source.png>              RGBA master PNG, transparent outside the logo."
  echo "                               Default: <out_dir>/source.png"
  echo
  echo "The master is trimmed + re-centered before any resize, so an off-center"
  echo "source is corrected. Alpha is preserved (never flattened)."
}

# check_dim <file> <expected_WxH> <intermediate_to_clean_on_fail>
check_dim() {
  local file="$1"
  local want="$2"
  local intermediate="$3"
  local got name
  name="$(basename "$file")"
  got="$(identify -format '%wx%h' "$file" 2>/dev/null || true)"
  if [[ "$got" != "$want" ]]; then
    echo -e "> FAIL: ${name} is '${got}', expected '${want}'" >&2
    rm -f "$intermediate"
    exit 1
  fi
  echo -e ">\t${name} -> ${got}"
}

main() {
  local src="$1"
  local out="$2"
  local master="${out}/source.png"
  local centered="${out}/${CENTERED}"

  # --- validate inputs ---
  if [[ ! -f "$src" ]]; then
    echo -e "> ERROR: source not found: $src" >&2
    exit 1
  fi
  if ! command -v magick >/dev/null 2>&1; then
    echo -e "> ERROR: ImageMagick 7 (magick) is required but not on PATH." >&2
    exit 1
  fi
  mkdir -p "$out"

  # Ensure the master lives at <out>/source.png (idempotent copy if invoked on a
  # master elsewhere). When src already is the master path, this is a no-op.
  if [[ "$src" != "$master" ]]; then
    cp "$src" "$master"
  fi

  # --- Stage 1: trim transparent border, re-center on a square canvas (D-03) ---
  # The master's opaque content is off-center (bbox 755x796 in an 817x817 canvas);
  # resizing BEFORE trim bakes that bias into every output. Trim first, then pad
  # to a centered square on the longer side. Keep -background none to preserve
  # alpha (never flatten — FAV-02 requires transparency outside the disc).
  echo -e "> Stage 1: trim + recenter"
  magick "$master" -trim -background none -gravity center \
    -extent "%[fx:max(w,h)]x%[fx:max(w,h)]" "$centered"

  # --- Stage 2: emit the 4 PNG targets at exact Chirpy v7.6.0 sizes ---
  echo -e "> Stage 2: resize to PNG targets"
  magick "$centered" -resize 96x96 "${out}/${FAV_96}"
  magick "$centered" -resize 180x180 "${out}/${APPLE}"
  magick "$centered" -resize 192x192 "${out}/${MANIFEST_192}"
  magick "$centered" -resize 512x512 "${out}/${MANIFEST_512}"

  # --- Stage 3: assemble multi-resolution favicon.ico (16, 32, 48) ---
  # IM handles ICO encoding (ICONDIR + per-size ICONDIRENTRY); do not hand-pack.
  echo -e "> Stage 3: assemble multi-resolution ICO (16/32/48)"
  magick "$centered" \
    \( -clone 0 -resize 16x16 \) \
    \( -clone 0 -resize 32x32 \) \
    \( -clone 0 -resize 48x48 \) \
    -delete 0 "${out}/${FAV_ICO}"

  # --- Stage 4: emit favicon.svg (MANDATORY — gem include hardcodes it; Pitfall 3) ---
  # The master is raster, so the SVG is raster-backed: a small 128x128 PNG
  # embedded as a base64 data URI inside a standalone <svg>. A true vector SVG
  # needs source vector art (out of scope this milestone).
  #
  # NOTE: do NOT use `magick ... favicon.svg` — IM7's SVG encoder delegates to
  # `potrace` (a vector tracer), which (a) may not be installed and (b) would
  # vectorize rather than embed the raster. We build the wrapper directly so the
  # output is deterministic and delegate-free.
  echo -e "> Stage 4: raster-backed SVG"
  local svg_png="${out}/_fav128.png"
  local b64
  magick "$centered" -resize 128x128 "$svg_png"
  b64="$(base64 -w 0 "$svg_png")"
  printf '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="128" height="128" viewBox="0 0 128 128">\n  <image xlink:href="data:image/png;base64,%s" width="128" height="128"/>\n</svg>\n' "$b64" > "${out}/${FAV_SVG}"
  rm -f "$svg_png"

  # --- Stage 5: self-check (dimensions + alpha preservation — FAV-02/FAV-03) ---
  echo -e "> Stage 5: self-check"
  check_dim "${out}/${FAV_96}" "96x96" "$centered"
  check_dim "${out}/${APPLE}" "180x180" "$centered"
  check_dim "${out}/${MANIFEST_192}" "192x192" "$centered"
  check_dim "${out}/${MANIFEST_512}" "512x512" "$centered"

  # Alpha preservation guard (FAV-02): transparent outside the disc.
  # Use %[type] (e.g. "TrueColorAlpha") — case-insensitive — because IM 7.1.2-15
  # renders %[channels] as lowercase "srgba 4.0", not the capitalized "Alpha"
  # substring the channel-string form would suggest. %[type] is the stable signal.
  if ! identify -format '%[type]' "${out}/${FAV_96}" | grep -qi 'alpha'; then
    echo -e "> FAIL: ${FAV_96} has no alpha channel (FAV-02 broken)" >&2
    rm -f "$centered"
    exit 1
  fi
  echo -e ">\t${FAV_96} alpha present ($(identify -format '%[type]' "${out}/${FAV_96}"))"

  # --- cleanup intermediate ---
  rm -f "$centered"

  echo -e "> Done. Edit ${out}/site.webmanifest theme_color/background_color by hand."
}

# --- arg parse (while/case, per tools/test.sh) ---
while (($#)); do
  opt="$1"
  case $opt in
  -o | --output)
    OUT_DIR="${2:?--output requires a value}"
    shift 2
    ;;
  -h | --help)
    help
    exit 0
    ;;
  -*)
    echo -e "> Unknown option: '$opt'\n" >&2
    help
    exit 1
    ;;
  *)
    # first positional = source
    if [[ -z "$SRC" ]]; then
      SRC="$1"
    else
      echo -e "> Unexpected argument: '$1'\n" >&2
      help
      exit 1
    fi
    shift
    ;;
  esac
done

# Default the source to the relocated master if not given.
if [[ -z "$SRC" ]]; then
  SRC="${OUT_DIR}/source.png"
fi

main "$SRC" "$OUT_DIR"
