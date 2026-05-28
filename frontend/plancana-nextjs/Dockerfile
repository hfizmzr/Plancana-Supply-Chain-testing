# # Repository: https://github.com/Mirzaazhan/Plancana-Supply-Chain
# # WIF3005 Alternative Assessment - Agricultural Supply Chain Frontend

# FROM node:18-alpine AS builder

# # Set working directory
# WORKDIR /app

# # Copy package files
# COPY package*.json ./

# # Install dependencies
# RUN npm install

# # Copy application source code
# COPY . .

# # Build the Next.js application for production
# RUN npm run build

# # Production stage
# FROM node:18-alpine AS runner

# WORKDIR /app

# ENV NODE_ENV=production

# # Copy the standalone build
# COPY --from=builder /app/.next/standalone ./
# COPY --from=builder /app/.next/static ./.next/static
# COPY --from=builder /app/public ./public

# # Expose the application port
# EXPOSE 3000

# # Health check
# HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
#   CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# # Start the standalone server
# CMD ["node", "server.js"]

FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]