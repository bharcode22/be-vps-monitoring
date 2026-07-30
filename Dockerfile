FROM node:20-alpine

# Install build dependencies for native modules and SSH client
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev \
    curl \
    openssh-client

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install project production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Create directory for persistent SQLite database
RUN mkdir -p /app/data

# Expose server port
EXPOSE 5002

ENV NODE_ENV=production
ENV PORT=5002

# Start Express server entrypoint
CMD ["node", "src/server.js"]
