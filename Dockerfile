FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p data
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
