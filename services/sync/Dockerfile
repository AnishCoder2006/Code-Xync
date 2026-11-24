# Sync service image. Self-contained: builds its own Prisma client from
# services/sync/prisma/schema.prisma (a checked copy of the root schema) and imports
# nothing from services/api. Build context = services/sync.
FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY prisma ./prisma/
RUN npm install --no-audit --no-fund
RUN npx prisma generate --schema prisma/schema.prisma
COPY . .
RUN npm run build
EXPOSE 4001
CMD ["node", "dist/index.js"]
