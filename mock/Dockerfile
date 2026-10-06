FROM node:22-alpine
WORKDIR /srv
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 4000
CMD ["node", "server.js"]