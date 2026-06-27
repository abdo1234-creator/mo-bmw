FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite WAL files and uploads persist via Railway volume
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "server.js"]
