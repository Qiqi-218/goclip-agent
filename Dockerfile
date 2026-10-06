FROM node:22-bookworm

WORKDIR /app

RUN corepack enable

COPY . .

WORKDIR /app/platform/dsh
RUN pnpm install --frozen-lockfile
RUN pnpm run build

EXPOSE 7860

CMD ["node", "apps/cli/lib/bin.js", "web", "--host", "0.0.0.0", "--allow-public-bind", "--port", "7860", "--trusted-host", "modelscope.cn", "www.modelscope.cn", "--no-open"]
