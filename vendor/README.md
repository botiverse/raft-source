# Vendored tarballs

Packages the workspace depends on that are not published to the npm registry, kept here so installs
never reach their upstream host.

| File | Package | Upstream | sha512 (the lockfile's `integrity`) |
|---|---|---|---|
| `xlsx-0.20.3.tgz` | SheetJS `xlsx` 0.20.3 (`packages/server`) | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz | `oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==` |

SheetJS publishes only to its own CDN, which was slow or unreachable from CI runners often enough
to stall installs.

To update: download the new tarball from the upstream URL, check its sha512
(`openssl dgst -sha512 -binary <file> | base64`), replace the file, point the `file:` specifier at
it, run `pnpm install --lockfile-only`, and confirm the lockfile's integrity equals the sha512 you
computed. Docker images that install the package copy this directory (`packages/server/Dockerfile`).
