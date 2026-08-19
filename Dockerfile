FROM node:20-alpine

# Install build dependencies, OpenSSL (required by Prisma), and system tools
RUN apk add --no-cache \
    openssl \
    curl \
    openssh-client \
    git \
    bash \
    docker-cli \
    docker-cli-compose \
    python3 \
    make \
    g++

WORKDIR /app

# Copy package management files and Prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies and generate Prisma Client engine
RUN npm install
RUN npx prisma generate
RUN npm prune --production

# Copy application source code
COPY . .

# Expose server port
EXPOSE 5002

ENV NODE_ENV=production
ENV PORT=5002

# Start Express server entrypoint
CMD ["node", "src/server.js"]
