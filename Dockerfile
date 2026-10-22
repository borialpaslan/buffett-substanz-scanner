FROM node:22-alpine

WORKDIR /app

# Dependencies zuerst installieren (optimales Layer-Caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Anwendungscode & initialen Tages-Cache kopieren
COPY server.js ./
COPY src ./src
COPY public ./public
COPY data ./data

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
