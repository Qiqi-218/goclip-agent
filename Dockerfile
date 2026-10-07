FROM node:22-bookworm

WORKDIR /app

RUN corepack enable

COPY . .

WORKDIR /app/platform/dsh
RUN pnpm install --frozen-lockfile

# ModelScope's Docker context does not include .git, while the client build
# normally derives this value with `git rev-parse HEAD`.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

RUN pnpm run build

EXPOSE 7860

CMD ["node", "apps/cli/lib/bin.js", "web", "--host", "0.0.0.0", "--allow-public-bind", "--port", "7860", "--trusted-host", "modelscope.cn", "www.modelscope.cn", "--no-open"]
