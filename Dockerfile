FROM node:20-alpine

# Install OpenSSL (required by Prisma) and essential runtime tools (without heavy C++ compilers)
RUN apk add --no-cache \
    openssl \
    curl \
    openssh-client \
    git \
    bash \
    docker-cli \
    docker-cli-compose

WORKDIR /app

# Copy package management files and Prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies, generate Prisma Client engine, and prune dev dependencies
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
