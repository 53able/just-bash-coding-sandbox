#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ASSET_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../assets" && pwd)
ROOT=""; VERSION=${JUST_BASH_VERSION:-3.4.2}; RUNTIME_DIR=""
IMAGE=${JUST_BASH_NODE_IMAGE:-"node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"}
LOCK_SHA256=f6b4946ba20f365dc5ae8652ce60cd233b7850e9d7c3091cff733609ce087eef
usage() { echo "Usage: $0 --root <repository> [--version 3.4.2] [--runtime-dir <empty-dir>]" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || usage; ROOT=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || usage; VERSION=$2; shift 2 ;;
    --runtime-dir) [ "$#" -ge 2 ] || usage; RUNTIME_DIR=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$ROOT" ] || usage
[ "$VERSION" = "3.4.2" ] || { echo "ERROR: requested just-bash $VERSION does not match the bundled reviewed 3.4.2 lock; supply a separately reviewed lock rather than resolving freely." >&2; exit 1; }
[ -d "$ROOT" ] || { echo "ERROR: repository root does not exist: $ROOT" >&2; exit 1; }
[ -f "$ASSET_DIR/runtime-package-lock.json" ] && [ ! -L "$ASSET_DIR/runtime-package-lock.json" ] || { echo "ERROR: bundled runtime lock is missing or symlinked." >&2; exit 1; }
[ "$(shasum -a 256 "$ASSET_DIR/runtime-package-lock.json" | awk '{print $1}')" = "$LOCK_SHA256" ] || { echo "ERROR: bundled runtime lock SHA-256 mismatch." >&2; exit 1; }
[ -n "$RUNTIME_DIR" ] || RUNTIME_DIR="$HOME/.cache/just-bash-coding-sandbox/$VERSION"
ROOT_ABS=$(CDPATH= cd -- "$ROOT" && pwd -P)
if [ -e "$RUNTIME_DIR" ]; then
  [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] || { echo "ERROR: runtime path must be a non-symlink directory." >&2; exit 1; }
  RUNTIME_ABS=$(CDPATH= cd -- "$RUNTIME_DIR" && pwd -P)
else
  PARENT=$(dirname -- "$RUNTIME_DIR"); BASE=$(basename -- "$RUNTIME_DIR")
  [ -d "$PARENT" ] || { echo "ERROR: runtime parent must already exist: $PARENT" >&2; exit 1; }
  RUNTIME_ABS=$(CDPATH= cd -- "$PARENT" && pwd -P)/$BASE
fi
reject_mount_path() { case "$1" in *','*|*'
'*|*'
'*) echo "ERROR: Apple Container mount paths containing comma or newline are unsupported: $1" >&2; exit 1 ;; esac; }
reject_mount_path "$ROOT_ABS"; reject_mount_path "$RUNTIME_ABS"; reject_mount_path "$ASSET_DIR"
case "$IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) : ;; *) echo "ERROR: JUST_BASH_NODE_IMAGE must be an immutable @sha256 reference." >&2; exit 1 ;; esac
case "$RUNTIME_ABS/" in "$ROOT_ABS/"*) echo "ERROR: runtime directory must not equal or be inside the repository: $RUNTIME_ABS" >&2; exit 1 ;; esac
case "$ROOT_ABS/" in "$RUNTIME_ABS/"*) echo "ERROR: repository must not be inside runtime: $RUNTIME_ABS" >&2; exit 1 ;; esac
if [ ! -e "$RUNTIME_ABS" ]; then mkdir -m 700 "$RUNTIME_ABS"; fi
[ -d "$RUNTIME_ABS" ] && [ ! -L "$RUNTIME_ABS" ] || { echo "ERROR: runtime path must remain a non-symlink directory." >&2; exit 1; }
RUNTIME_REAL=$(CDPATH= cd -- "$RUNTIME_ABS" && pwd -P)
[ "$RUNTIME_REAL" = "$RUNTIME_ABS" ] || { echo "ERROR: runtime path changed during validation: expected $RUNTIME_ABS, got $RUNTIME_REAL" >&2; exit 1; }
[ -z "$(find "$RUNTIME_REAL" -mindepth 1 -print -quit)" ] || { echo "ERROR: runtime directory must be empty; refusing to mix reviewed and stale inputs." >&2; exit 1; }
"$SCRIPT_DIR/ensure-apple-container-ready.sh" >/dev/null
TMP_ROOT=$(mktemp -d); trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM
cat > "$TMP_ROOT/bootstrap.sh" <<'GUEST'
#!/bin/bash
set -Eeuo pipefail
printf '%s  %s\n' "$LOCK_SHA256" /assets/runtime-package-lock.json | sha256sum -c -
cp /assets/runtime-package-lock.json /runtime/package-lock.json
cat > /runtime/package.json <<'JSON'
{"name":"just-bash-coding-sandbox-runtime","private":true,"version":"1.0.0","type":"module","dependencies":{"just-bash":"3.4.2"}}
JSON
cd /runtime
npm ci --ignore-scripts --no-audit --no-fund
npm ls --all --json > installed-package-tree.json
node <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
const entries=[];
function walk(dir, prefix="") { for (const name of fs.readdirSync(dir).sort()) { const full=path.join(dir,name), rel=prefix?`${prefix}/${name}`:name, st=fs.lstatSync(full); if(st.isDirectory()) walk(full,rel); else if(st.isFile()) entries.push(`${rel}\0file\0${hashFile(full)}`); else if(st.isSymbolicLink()) entries.push(`${rel}\0symlink\0${fs.readlinkSync(full)}`); else throw new Error(`unsupported runtime tree entry: ${rel}`); } }
walk("node_modules");
const treeSha256=crypto.createHash("sha256").update(entries.join("\0")+"\0").digest("hex");
const receipt={schemaVersion:1,image:process.env.IMAGE,lockSha256:process.env.LOCK_SHA256,justBashVersion:"3.4.2",npmLsSha256:hashFile("installed-package-tree.json"),nodeModulesTreeSha256:treeSha256,nodeModulesEntryCount:entries.length};
fs.writeFileSync("runtime-receipt.json", JSON.stringify(receipt,null,2)+"\n", {flag:"wx",mode:0o600});
NODE
GUEST
chmod 500 "$TMP_ROOT/bootstrap.sh"
RUNTIME_BEFORE_MOUNT=$(CDPATH= cd -- "$RUNTIME_REAL" && pwd -P)
[ "$RUNTIME_BEFORE_MOUNT" = "$RUNTIME_REAL" ] && [ ! -L "$RUNTIME_REAL" ] || { echo "ERROR: runtime path changed before mount." >&2; exit 1; }
[ -z "$(find "$RUNTIME_REAL" -mindepth 1 -print -quit)" ] || { echo "ERROR: runtime directory changed before mount." >&2; exit 1; }
container run --rm --cpus 2 --memory 1G --cap-drop ALL \
  --mount "type=bind,source=$RUNTIME_ABS,target=/runtime" --mount "type=bind,source=$ASSET_DIR,target=/assets,readonly" \
  --mount "type=bind,source=$TMP_ROOT,target=/bootstrap,readonly" --workdir /runtime \
  -e "LOCK_SHA256=$LOCK_SHA256" -e "IMAGE=$IMAGE" "$IMAGE" /bin/bash /bootstrap/bootstrap.sh
JUST_BASH_RUNTIME_DIR="$RUNTIME_ABS" JUST_BASH_NODE_IMAGE="$IMAGE" "$SCRIPT_DIR/run-just-bash-apple-container.sh" --root "$ROOT_ABS" --smoke
printf 'BOOTSTRAP_OK: just-bash %s installed with lock %s; receipt at %s/runtime-receipt.json; smoke passed.\n' "$VERSION" "$LOCK_SHA256" "$RUNTIME_ABS"
