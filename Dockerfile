FROM oven/bun:latest

# Basic system utilities, lm-sensors, and Docker CLI (allows exec'ing into other containers)
RUN apt-get update && apt-get install -y \
    pciutils \
    curl \
    ca-certificates \
    lm-sensors \
    && curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh \
    && rm -f get-docker.sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app


## Do not copy source code into the image; code will be mounted as a volume for development.

# Install JS deps (if any). Continue even if no lockfile or package.json changes.
RUN bun install --no-save || true

ENV PORT=4000
EXPOSE 4000

# Add this to your Dockerfile to ensure logs are flushed immediately
ENV BUN_CONFIG_NO_BUFFER=1

# Run the server
CMD ["bun", "run", "index.ts"]