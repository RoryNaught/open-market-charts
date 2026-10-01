FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY LICENSE NOTICE ./
COPY packages ./packages
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --ignore-scripts && npm cache clean --force
COPY apps/gateway/src ./apps/gateway/src
ENV NODE_ENV=production
ENV OMC_GATEWAY_HOST=0.0.0.0
ENV OMC_GATEWAY_PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "run", "gateway"]
