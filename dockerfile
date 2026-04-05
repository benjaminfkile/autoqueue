# ---- Build stage ----
FROM node:20 AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# ---- AWS config (injected at build time, exposed as env vars) ----
ARG AWS_REGION
ARG AWS_SECRET_ARN
ARG AWS_DB_SECRET_ARN
ARG NODE_ENVIRONMENT

ENV AWS_REGION=$AWS_REGION
ENV AWS_SECRET_ARN=$AWS_SECRET_ARN
ENV AWS_DB_SECRET_ARN=$AWS_DB_SECRET_ARN
ENV NODE_ENVIRONMENT=$NODE_ENVIRONMENT
ENV PORT=$PORT

EXPOSE $PORT

CMD ["node", "dist/index.js"]
