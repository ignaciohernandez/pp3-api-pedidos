FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3103
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
