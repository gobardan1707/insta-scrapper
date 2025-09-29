# Use a slim Debian image
FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies required by Chromium / Puppeteer
RUN apt-get update && apt-get install -y \
    curl gnupg2 ca-certificates apt-transport-https \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libgtk-3-0 libnspr4 libnss3 libxss1 libxshmfence1 libgbm1 \
    libdrm2 libx11-xcb1 libxcb1 libxdamage1 libxfixes3 libxrandr2 \
    libcups2 libdbus-1-3 libglib2.0-0 libgobject-2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package definition and install
COPY package*.json ./
RUN npm install

# Copy the rest of your code
COPY . .

# Expose the port (if your server listens on 3000)
EXPOSE 3000

# Start command — change if your entry file is different
CMD ["node", "server.js"]
