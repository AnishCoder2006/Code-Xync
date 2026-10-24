FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
# Needs Docker socket mounted at runtime (see infra/docker/docker-compose.prod.yml)
CMD ["npm", "start"]
