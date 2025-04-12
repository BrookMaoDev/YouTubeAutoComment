FROM node:slim

WORKDIR /home/node/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 80
USER node
CMD ["node", "app.js"]
