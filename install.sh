#!/bin/sh
# Codex WorkBuddy Suite - macOS bootstrap.
# Downloads a fixed, checksum-verified release, then runs the local installer.
set -eu
SUITE_VERSION='0.2.0'
REPO='ztg-pty/codex-workbuddy-suite'
NODE_VERSION='24.15.0'

case "$(uname -s)" in
  Darwin) : ;;
  *) echo 'Codex WorkBuddy Suite currently supports Windows and macOS only; Linux is not supported.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64) ARCH='arm64' ;;
  x86_64) ARCH='x64' ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

ROOT="${HOME}/Library/Application Support/CodexWorkBuddySuite"
TOOLS="${ROOT}/node"
NODE_DIR="${TOOLS}/node-v${NODE_VERSION}-darwin-${ARCH}"
NODE_BIN="${NODE_DIR}/bin/node"

if [ ! -x "${NODE_BIN}" ]; then
  echo "Downloading Node.js ${NODE_VERSION} (${ARCH})..."
  mkdir -p "${TOOLS}"
  ARCHIVE="${TOOLS}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  curl --proto '=https' --tlsv1.2 -fsSL -o "${ARCHIVE}" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  EXPECTED="$(curl --proto '=https' --tlsv1.2 -fsSL "https://raw.githubusercontent.com/${REPO}/main/toolchain.json" | sed -n "s/.*\"node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz\"[[:space:]]*:[[:space:]]*\"\([0-9a-f]*\)\".*/\1/p")"
  [ -n "${EXPECTED}" ] || { echo 'toolchain.json has no checksum for this archive.' >&2; exit 1; }
  ACTUAL="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
  [ "${ACTUAL}" = "${EXPECTED}" ] || { echo 'Node.js archive checksum mismatch.' >&2; exit 1; }
  tar -xzf "${ARCHIVE}" -C "${TOOLS}"
  rm -f "${ARCHIVE}"
fi

SRC_ROOT="${ROOT}/src"
mkdir -p "${SRC_ROOT}"
echo "Downloading Codex WorkBuddy Suite ${SUITE_VERSION}..."
curl --proto '=https' --tlsv1.2 -fsSL -o "${SRC_ROOT}/suite.tar.gz" "https://github.com/${REPO}/archive/refs/tags/v${SUITE_VERSION}.tar.gz"
rm -rf "${SRC_ROOT}/codex-workbuddy-suite-${SUITE_VERSION}"
tar -xzf "${SRC_ROOT}/suite.tar.gz" -C "${SRC_ROOT}"
SUITE_ROOT="${SRC_ROOT}/codex-workbuddy-suite-${SUITE_VERSION}"

export PATH="${NODE_DIR}/bin:${PATH}"
echo 'Starting Codex WorkBuddy Suite setup...'
exec "${NODE_BIN}" "${SUITE_ROOT}/scripts/bootstrap-runtime.mjs"
