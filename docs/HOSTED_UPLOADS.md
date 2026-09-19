# Hosted recording uploads

RailGuard is hosted at [railguard.grabtch.com](https://railguard.grabtch.com/).
The owner manages the Docker deployment. Source changes require the frontend
image to be rebuilt and the container to be recreated; restarting an old image
does not install a new Next.js route.

## Upload transport

`POST /api/ps3/jobs` uses an explicit Node-runtime Next.js route. It streams the
original multipart body to the Python API without calling `formData()`, storing
the entire upload in frontend memory, or using the external-rewrite body clone.
`GET` on the same route preserves saved-analysis listing and query filters.
The remaining API paths retain their existing rewrites.

The API destination uses runtime `RAILGUARD_API_URL`, then the address captured
at frontend build time, then `http://127.0.0.1:8000`. Separate Docker containers
must use an address reachable from the frontend container; loopback points to
the frontend container itself. Supply the appropriate internal API URL when
building and running the image. It must be HTTP(S) without embedded credentials.

The Python service still validates **64 MiB per file**, **100 files** and
**1,500 MiB per batch** (one continuous file for Door). The frontend route also
bounds total streamed bytes to 1,501 MiB, allowing 1 MiB of multipart overhead.
Uploads have a ten-minute route deadline and stop forwarding when the client
disconnects. POST requests are never automatically retried. After an interrupted
response, check saved analyses before uploading again because the API might
already have accepted the job. Keep each recording intact; reduce batch size by
selecting fewer complete files.

## Verify a new deployment

1. Request `/api/ps3/jobs?limit=1`. A response from the streaming route includes
   `X-RailGuard-Upload-Transport: stream-v1` and `Cache-Control: no-store`.
2. Upload one intact official Rail CSV (about 16.5 MiB). Expect HTTP 202 with a
   job ID, then poll the normal job endpoint until analysis completes.
3. Upload two complete recordings together. Confirm both filenames and outputs
   appear, reload the page, and download their CSV.
4. Check that Door, ACV and SHM retain the same upload and saved-run behavior.

An OpenResty/Nginx proxy in front of the frontend may enforce its own body size,
buffering, timeout and temporary-storage rules. The new route does not override
those settings. If a request never reaches this route, inspect the outer proxy
logs and settings; if it does, inspect frontend and Python service logs. Never
include credentials in logs shared for troubleshooting.

## Failure reproduced before this change

On 19 September 2026, an 8 MiB diagnostic upload reached API validation, while
11 MiB and the 16.48 MiB Rail `Test1.csv` returned plain HTTP 500 after about
31 seconds. Local inference accepted the intact Rail file. The observed size
boundary and response matched Next.js's default 10 MiB clone limit and default
30-second external-proxy timeout; the exact deployed container settings were
not accessible. The repository's larger configuration was already present, so
this fix removes the upload's dependence on that rewrite mechanism.

Next.js documents that the [proxy body buffer](https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize)
can truncate bodies above its configured limit. The dedicated route is verified
with a real HTTP transfer larger than 10 MiB, including full byte count and hash,
as well as size enforcement, backend validation errors, timeouts, disconnection,
redirect refusal and saved-run listing tests.

Local production verification also forced the old 10 MiB/30-second rewrite
settings: the complete 16.48 MiB Rail file and a two-file 33.15 MiB batch both
returned HTTP 202, completed inference, retained matching source hashes, appeared
in saved analyses and exported CSVs. One official Door, ACV and SHM recording
each passed the same workflow. These local checks do not substitute for testing
the rebuilt image behind the live server's own proxy.
