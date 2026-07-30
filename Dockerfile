FROM node:20-slim

# Install system dependencies for native build and curl for healthcheck
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    curl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install project dependencies
RUN npm install

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
