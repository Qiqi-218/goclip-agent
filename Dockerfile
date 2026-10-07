FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ffmpeg fontconfig fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY . .

# ModelScope's Docker context does not include .git, while the client build
# normally derives this value with `git rev-parse HEAD`.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

RUN bash setup.sh

EXPOSE 7860

CMD ["node", "runtime/start-dsh.mjs", "--host", "0.0.0.0", "--allow-public-bind", "--port", "7860", "--trusted-host", "modelscope.cn", "www.modelscope.cn", "--no-open"]
