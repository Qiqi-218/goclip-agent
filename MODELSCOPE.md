# ModelScope Studio deployment

This project is deployed as a Docker Studio. The container listens on `0.0.0.0:7860`; the explicit
`--allow-public-bind` flag is required because a normal local `dsh web` process stays loopback-only.

1. Create a public ModelScope Studio with Docker deployment and upload this repository.
2. Keep `ms_deploy.json` at the repository root. The default CPU resource is the smallest project setting;
   choose a different resource only if the Studio account offers it and the workload needs it.
3. Deploy and open the Studio URL. The app's browser token is printed in the Studio run log as part of the
   `dsh web:` URL; keep that query token private.

The container trusts `modelscope.cn` and `www.modelscope.cn`, which are the public ModelScope authorities used
by the Studio URL. If the platform gives the Studio a different public authority, add it to the Docker `CMD`
`--trusted-host` list before redeploying.

The default runtime data is inside the container. For data that must survive restarts, configure ModelScope's
persistent `/mnt/workspace` storage or an external storage service; do not commit credentials to the repository.
