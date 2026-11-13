FROM node:22-alpine

LABEL org.opencontainers.image.title="EQS" \
      org.opencontainers.image.description="开源一体化问卷 / 考试 / 刷题平台" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web

ENV NODE_ENV=production \
    PORT=8080 \
    EQS_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server/index.js"]
