FROM node:20-bookworm

# Instalar ffmpeg, python3 y dependencias para yt-dlp
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Directorio de trabajo
WORKDIR /app

# Instalar dependencias del bot
COPY package*.json ./
RUN npm install

# Copiar el codigo del bot
COPY . .

CMD ["node", "index.js"]
