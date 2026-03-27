FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN useradd -m appuser
RUN chown -R appuser:appuser /app
USER appuser

RUN npm run build

CMD ["npm", "start"]