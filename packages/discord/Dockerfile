FROM oven/bun:1.3.9-alpine

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/discord.sqlite
ENV HEALTH_HOST=0.0.0.0
ENV HEALTH_PORT=8787

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8787

CMD ["bun", "run", "src/index.ts"]
