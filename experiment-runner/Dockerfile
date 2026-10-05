FROM grafana/k6:latest

USER root

RUN apk add --no-cache nodejs npm docker-cli

WORKDIR /app

COPY server.js /app/server.js

RUN npm install express cors

EXPOSE 5000

ENTRYPOINT []
CMD ["node", "/app/server.js"]
