#!/bin/sh
# Runs one exercise's own test suite in /work (the exercise copy).
# No network: dependencies were pre-fetched into the image (see Dockerfile).
set -u
cd /work || exit 2

case "${1:-}" in
  python)     exec python3 -m pytest -q ;;
  go)         exec go test ./... ;;
  rust)       exec cargo test --offline -- --include-ignored ;;
  javascript) ln -sfn /opt/js/node_modules node_modules && exec node_modules/.bin/jest ;;
  java)       exec gradle -Dorg.gradle.daemon.registry.base=/tmp/gradle-daemon test --offline --no-daemon --console=plain ;;
  cpp)
    # CMakeLists derives the exercise name from the source directory name, so
    # build from a copy named after the exercise (zebra_puzzle_test.cpp -> zebra-puzzle).
    name=$(basename "$(ls ./*_test.cpp | head -n 1)" _test.cpp | tr _ -)
    mkdir -p /tmp/src/"$name" && cp -a /work/. /tmp/src/"$name"/ && cd /tmp/src/"$name" || exit 2
    cmake -S . -B build -DEXERCISM_RUN_ALL_TESTS=1 && exec cmake --build build ;;
  *)
    echo "usage: run-tests.sh python|go|rust|javascript|java|cpp" >&2
    exit 2
    ;;
esac
