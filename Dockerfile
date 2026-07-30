FROM node:20-slim

# Install system build dependencies and libsqlite3-dev for native C++ compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    libsqlite3-dev \
    curl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install project dependencies & compile sqlite3 from source against container's GLIBC version
RUN npm install && npm rebuild sqlite3 --build-from-source

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
