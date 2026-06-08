FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
