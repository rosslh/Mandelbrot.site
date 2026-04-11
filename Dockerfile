# syntax=docker/dockerfile:1.6

# ---- Build stage ----------------------------------------------------------
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal \
 && rustup target add wasm32-unknown-unknown \
 && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

WORKDIR /app

COPY Cargo.toml ./
COPY mandelbrot ./mandelbrot
COPY client ./client

WORKDIR /app/client

# Skip the `postinstall` native `cargo build` — the production image only
# needs the wasm output, which `@wasm-tool/wasm-pack-plugin` produces during
# `npm run build`.
RUN npm ci --ignore-scripts

ARG SUPABASE_PROJECT_ID
ARG SUPABASE_ANON_KEY
ENV SUPABASE_PROJECT_ID=${SUPABASE_PROJECT_ID} \
    SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}

RUN npm run build

# ---- Runtime stage --------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
