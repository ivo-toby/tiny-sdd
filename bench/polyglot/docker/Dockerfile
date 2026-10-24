# Test runner image for the polyglot benchmark (tinysdd-polyglot:1).
# Network is used only while building; every dependency the exercises need is
# fetched here, so run-tests.sh works with `--network none`.
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG GRADLE_VERSION=8.7

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/tmp \
    PATH=/opt/cargo/bin:/opt/node/bin:/opt/gradle/bin:/usr/local/bin:/usr/bin:/bin \
    GRADLE_USER_HOME=/opt/gradle-home \
    CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    CARGO_TARGET_DIR=/opt/cargo-target \
    CARGO_NET_OFFLINE=true \
    GOCACHE=/opt/go-cache \
    GOPATH=/opt/go \
    GOPROXY=off \
    GOTOOLCHAIN=local \
    GOFLAGS=-buildvcs=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils unzip \
      python3 python3-pytest \
      golang-go \
      build-essential cmake \
      libboost-date-time-dev libtbb-dev \
      openjdk-21-jdk-headless \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/node.tar.xz \
      https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/node \
 && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && rm /tmp/node.tar.xz

RUN curl -fsSL -o /tmp/gradle.zip \
      https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip \
 && echo "$(curl -fsSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip.sha256)  /tmp/gradle.zip" | sha256sum -c - \
 && cd /opt && unzip -q /tmp/gradle.zip && mv gradle-${GRADLE_VERSION} gradle \
 && rm /tmp/gradle.zip

RUN curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --profile minimal --default-toolchain stable --no-modify-path \
 && rm /tmp/rustup-init

# JavaScript: one shared node_modules, linked into /work by run-tests.sh.
COPY warm/js/package.json /opt/js/package.json
RUN cd /opt/js && npm install --no-audit --no-fund \
 && /opt/js/node_modules/.bin/jest --version

# Java: warm the Gradle cache with a throwaway project, then prove it works offline.
COPY warm/java /opt/warm/java
RUN cd /opt/warm/java && gradle test --no-daemon --console=plain \
 && gradle test --offline --no-daemon --console=plain \
 && rm -rf /opt/warm/java

# Rust: fetch and compile anyhow, rand 0.8 and time 0.3 into the shared target dir.
COPY warm/rust /opt/warm/rust
RUN cd /opt/warm/rust \
 && CARGO_NET_OFFLINE=false cargo generate-lockfile \
 && CARGO_NET_OFFLINE=false cargo test --no-run \
 && cargo test --offline --no-run \
 && rm -rf /opt/warm/rust

# Go: the exercises use only the standard library; warm the build cache.
COPY warm/go /opt/warm/go
RUN cd /opt/warm/go && go test ./... \
 && rm -rf /opt/warm/go

# Caches are written by the test run. Containers run as the host uid, so make them writable.
# Each `docker run --rm` gets its own writable layer, so nothing leaks between runs.
RUN mkdir -p /opt/go && chmod -R a+rwX /opt/gradle-home /opt/cargo /opt/rustup /opt/cargo-target /opt/go-cache /opt/go /opt/js

COPY run-tests.sh /usr/local/bin/run-tests.sh
RUN chmod 0755 /usr/local/bin/run-tests.sh

WORKDIR /work
