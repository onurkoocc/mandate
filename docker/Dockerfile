# The image the CI jobs of this repository are run in locally (scripts/docker-ci.sh): the same toolchain versions as
# .github/workflows/ci.yml and rust-toolchain.toml, each pinned and, where it is downloaded, checked against a sha256.
# docker/check.mjs fails when a value below differs from the one in those two files.
#
# The build context is this directory (docker/) and nothing else: no repository file and no file of the host's working
# tree can reach the image. The repository itself is not in the image; the job runner clones a commit into /ci/repo.

# Ubuntu 24.04 LTS, pinned by the digest of its manifest list. Its archive has what the sandbox job installs
# (bubblewrap, slirp4netns, iptables, iproute2, util-linux).
FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

ARG DEBIAN_FRONTEND=noninteractive

# What cargo needs to link (a C compiler as the linker), what npm and the tests need (git, curl, certificates, xz for
# the Node tarballs), and the sandbox job's packages. Package versions are those of the archive on the day of the build.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl git xz-utils build-essential pkg-config \
      bubblewrap slirp4netns iptables iproute2 util-linux \
      procps diffutils findutils python3 \
 && rm -rf /var/lib/apt/lists/*

# Node, two releases side by side: the test job runs on NODE22_VERSION, the rust, parity and sandbox jobs on
# NODE24_VERSION (ci.yml's setup-node steps). The job runner puts one of /opt/node-<version>/bin on the PATH. The
# sha256 is the one nodejs.org publishes in SHASUMS256.txt next to each tarball.
ARG NODE22_VERSION=22.23.4
ARG NODE22_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG NODE24_VERSION=24.22.1
ARG NODE24_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
RUN set -eu; \
    for spec in "${NODE22_VERSION} ${NODE22_SHA256}" "${NODE24_VERSION} ${NODE24_SHA256}"; do \
      set -- $spec; \
      curl -fsSL --retry 3 -o /tmp/node.tar.xz "https://nodejs.org/dist/v$1/node-v$1-linux-x64.tar.xz"; \
      echo "$2  /tmp/node.tar.xz" | sha256sum -c -; \
      mkdir "/opt/node-$1"; \
      tar -xJf /tmp/node.tar.xz -C "/opt/node-$1" --strip-components=1; \
      rm /tmp/node.tar.xz; \
    done

# OPA, the static Linux build of one release; its sha256 is the one the release publishes next to it
# (opa_linux_amd64_static.sha256), the same as in ci.yml, and is checked before the binary is installed.
ARG OPA_VERSION=1.4.2
ARG OPA_SHA256=2c0ccdbbe0b8e2a5d12d9c42d92f1f34f494ffb32d1f3c4ddc36101be637d66f
RUN curl -fsSL --retry 3 -o /tmp/opa "https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/opa_linux_amd64_static" \
 && echo "${OPA_SHA256}  /tmp/opa" | sha256sum -c - \
 && install -m 0755 /tmp/opa /usr/local/bin/opa \
 && rm /tmp/opa \
 && opa version

# The user the jobs run as. Ubuntu 24.04 ships a user `ubuntu` with uid 1000; it is replaced, so that the uid is
# the one the OpenTelemetry Collector of compose.yml runs as and the one that owns the volumes. /ci/repo is where a
# commit is extracted (not /work: the Gate 3 rehearsal of the sandbox job writes /work/repo itself). Its target/ is in
# the container's own file system: a job never builds on another job's artifacts.
# /run/systemd/resolve and /run/user/1000 are places the sandbox job's tests of the host's sockets use, as they are on
# the GitHub runner (docker/README.md).
RUN userdel -r ubuntu 2>/dev/null || true; \
    useradd --uid 1000 --create-home --shell /bin/bash ci \
 && mkdir -p /opt/rustup /opt/cargo /cache/cargo /cache/npm /ci/repo /work /otel/config /otel/out /run/systemd/resolve /run/user/1000 \
 && chown -R ci:ci /opt/rustup /opt/cargo /cache /ci /work /otel /run/systemd /run/user && chmod 700 /run/user/1000

USER ci
WORKDIR /ci

# Rust, as rust-toolchain.toml pins it: the channel, the components, the target and the profile. rustup-init is the
# one of rustup 1.28.2, checked against its published sha256; rustup then verifies every toolchain download against the
# hashes of the channel manifest. The toolchain lives in /opt/rustup and the proxies in /opt/cargo/bin; the cargo
# registry and git caches are the volume at /cache/cargo (CARGO_HOME at run time), so that they survive the container.
ARG RUSTUP_VERSION=1.28.2
ARG RUSTUP_INIT_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
ARG RUST_CHANNEL=1.100.0
ARG RUST_COMPONENTS="rustfmt clippy"
ARG RUST_TARGET=wasm32-wasip1
ARG RUST_PROFILE=minimal
ENV RUSTUP_HOME=/opt/rustup
RUN curl -fsSL --retry 3 -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_INIT_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && CARGO_HOME=/opt/cargo /tmp/rustup-init -y --no-modify-path \
      --default-toolchain "${RUST_CHANNEL}" --profile "${RUST_PROFILE}" \
      $(for c in ${RUST_COMPONENTS}; do printf -- '-c %s ' "$c"; done) -t "${RUST_TARGET}" \
 && rm /tmp/rustup-init \
 && CARGO_HOME=/opt/cargo /opt/cargo/bin/rustc --version

# Node 24 is the default; the job runner changes the PATH for the test job.
ENV NODE22_HOME=/opt/node-${NODE22_VERSION} \
    NODE24_HOME=/opt/node-${NODE24_VERSION} \
    PATH=/opt/node-${NODE24_VERSION}/bin:/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    CARGO_HOME=/cache/cargo \
    npm_config_cache=/cache/npm \
    CARGO_TERM_COLOR=never \
    CI=true \
    HOME=/home/ci

# No setuid or setgid binary is left in the image: with no-new-privileges they would do nothing, and without them
# there is nothing for a process of a job to gain.
USER root
RUN n="$(find / -xdev \( -perm -4000 -o -perm -2000 \) -type f | wc -l)" \
 && find / -xdev \( -perm -4000 -o -perm -2000 \) -type f -exec chmod a-s {} + \
 && echo "setuid or setgid bits removed from $n files" \
 && test -z "$(find / -xdev \( -perm -4000 -o -perm -2000 \) -type f)"

# The entry of the container, last, so that a rebuild for another checkout's scripts changes nothing before it
# (docker/README.md): boot.sh makes the checkout of the commit that arrives on the standard input and runs the commit's
# own docker/run-job.sh, or the copy of it here for a commit that has none. The Dockerfile and .dockerignore are copied
# in too, so that boot.sh can compute the digest that says whether this image is the one the checkout that started
# the job built (Dockerfile, .dockerignore and boot.sh decide that; run-job.sh is checked only when its copy is used).
COPY --chmod=0755 Dockerfile .dockerignore boot.sh run-job.sh /usr/local/lib/mandate-ci/

USER ci
