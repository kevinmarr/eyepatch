#!/bin/sh
# Install (or update) Eyepatch's Agent Bridge on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/kevinmarr/eyepatch/main/install.sh | sh
#
# Downloads the latest release for this computer, checks it against the
# release's SHA256SUMS, puts it in a stable place and registers it with every
# Chromium-based browser. Running it again updates Agent Bridge.
#
# EYEPATCH_VERSION=0.2.0 installs that version instead of the latest.
# Uninstall: run `eyepatch-agent-bridge uninstall` from the folder this prints, then
# delete that folder (and ~/.eyepatch for your mods, chats and agents).
set -eu

REPO="kevinmarr/eyepatch"

fail() {
  echo "Eyepatch: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this script is for macOS and Linux. On Windows, see https://github.com/$REPO#install" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac

# An x64 shell on Apple silicon (Rosetta): use the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

target="$os-$arch"
if [ "$os" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
  target="$target-musl"
fi

if [ "$os" = darwin ]; then
  dir="$HOME/Library/Application Support/Eyepatch"
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/eyepatch"
fi

if [ -n "${EYEPATCH_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/v${EYEPATCH_VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
asset="eyepatch-agent-bridge-$target.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Eyepatch Agent Bridge for ${target}..."
curl -fL --progress-bar "$base/$asset" -o "$tmp/$asset" || fail "couldn't download $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "couldn't download $base/SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "$asset isn't listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
# Replace by renaming: a copy Chrome is running keeps working until it quits.
mv -f "$tmp/eyepatch-agent-bridge" "$dir/eyepatch-agent-bridge"
chmod 755 "$dir/eyepatch-agent-bridge"

"$dir/eyepatch-agent-bridge" install
echo "Installed Eyepatch Agent Bridge $("$dir/eyepatch-agent-bridge" version) in $dir"
echo "Back in Chrome, Eyepatch's Settings page connects to it by itself."
