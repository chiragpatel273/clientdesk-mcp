# ClientDesk MCP: server + dashboard in one image.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY dashboard/package.json dashboard/package-lock.json dashboard/
RUN npm --prefix dashboard ci
COPY . .
RUN npm run build && npm run dashboard:build

# ---- runtime ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
COPY --from=build /app/dashboard/dist dashboard/dist
COPY migrations migrations
COPY eval/report.json eval/report.json
# Only used without Neon/R2 (local PGlite and files); production should use DATABASE_URL and STORAGE=r2.
RUN mkdir -p .data && chown node:node .data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
