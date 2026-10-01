#!/usr/bin/env bash
# Linux/GNU helper for immutable releases with persistent state outside their parent.
set -euo pipefail

if [[ $# -ne 3 ]]; then
    echo 'Usage: bash scripts/link-release-state.sh RELEASE CONFIG_FILE RUNTIME_DIR' >&2
    exit 1
fi

release=$(readlink -e -- "$1")
config=$(readlink -e -- "$2")
runtime=$(readlink -e -- "$3")
if [[ ! -d "$release" || ! -f "$config" || ! -d "$runtime" ]]; then
    echo 'Release, configuration file and runtime directory must exist with the expected types.' >&2
    exit 1
fi

# The parent is reserved for releases: persistent state must survive its cleanup.
release_parent=$(dirname -- "$release")
for target in "$config" "$runtime"; do
    if [[ "$target" == "$release_parent" || "$target" == "$release_parent/"* ]]; then
        echo 'Persistent state must be outside the directory containing releases.' >&2
        exit 1
    fi
done

# Validate both entries before replacing either; never overwrite real state.
for name in config.json runtime; do
    if [[ -e "$release/$name" && ! -L "$release/$name" ]]; then
        echo "Refusing to replace a real file or directory: $release/$name" >&2
        exit 1
    fi
done

temporary=$(mktemp -d -- "$release/.state-links.XXXXXX")
cleanup() {
    rm -f -- "$temporary/config.json" "$temporary/runtime"
    rmdir -- "$temporary"
}
trap cleanup EXIT
ln -s -- "$config" "$temporary/config.json"
ln -s -- "$runtime" "$temporary/runtime"
mv -Tf -- "$temporary/config.json" "$release/config.json"
mv -Tf -- "$temporary/runtime" "$release/runtime"
echo "Linked persistent configuration and runtime in $release"
