# 旅遊團控系統 — 零外部依賴的 Node 應用
# 使用 node:sqlite + node:http,不需 npm install,直接跑 server.js
FROM node:24-alpine

WORKDIR /app
COPY . .

# server.js 監聽 3000(容器內固定),對外 port 由 staging 系統的 ${PORT} 分配
EXPOSE 3000

CMD ["node", "server.js"]
