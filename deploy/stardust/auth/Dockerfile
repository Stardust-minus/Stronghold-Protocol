FROM node@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 UV_THREADPOOL_SIZE=2
WORKDIR /app
COPY server.mjs ./server.mjs
COPY THREE-LICENSE.txt ./THREE-LICENSE.txt
COPY public/ ./public/
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
