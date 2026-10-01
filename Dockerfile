FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data CONFIG_DIR=/app/config
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
