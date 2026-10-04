FROM node@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114
ARG SOURCE_REVISION=development
LABEL org.opencontainers.image.source="https://github.com/Stardust-minus/Stronghold-Protocol" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.description="Public asset signed-URL cache; no game runtime or account credentials"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 UV_THREADPOOL_SIZE=2
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status!==200)process.exitCode=1}).catch(()=>{process.exitCode=1})"
CMD ["node", "server.mjs"]
