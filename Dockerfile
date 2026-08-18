FROM node:22-bookworm-slim AS studio-build

WORKDIR /build/apps/studio
COPY apps/studio/package.json apps/studio/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/studio/ ./
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/tmp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY templates ./templates
COPY --from=studio-build /build/apps/studio/dist ./apps/studio/dist

RUN useradd --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --uid 10001 scrumstudio

USER scrumstudio

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
