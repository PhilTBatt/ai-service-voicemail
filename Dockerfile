FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x node_modules/.bin/tsc

RUN npm run build

CMD ["npm", "start"]