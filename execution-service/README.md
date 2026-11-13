# CodeGrade execution service

This service is the only component allowed to start student containers. It accepts JavaScript project files at `POST /execute` and runs them with Docker using:

- no network
- `npm install` is supported only for packages listed in `EXECUTION_ALLOWED_PACKAGES`; install scripts are disabled
- read-only project mount
- 0.5 CPU and 256 MB memory
- 64 process limit
- 10 second timeout
- dropped Linux capabilities and `no-new-privileges`

Start it locally from `CodeGrade-Backend`:

```bash
export EXECUTION_SERVICE_TOKEN=local-runner-token
docker compose up --build execution-service
```

Configure the API service with the same token:

```env
EXECUTION_SERVICE_URL=http://localhost:4001/execute
EXECUTION_SERVICE_TOKEN=local-runner-token
```

The execution service container requires access to the Docker socket so it can create short-lived sandbox containers. Run it on a dedicated trusted host; never expose port 4001 publicly.

To permit another dependency, add its exact npm package name:

```env
EXECUTION_ALLOWED_PACKAGES=express,mongoose,bcryptjs,jsonwebtoken,cors,multer,dotenv
```

Students declare allowed packages with numeric versions in `package.json`, then use
`npm install` in the integrated terminal. Install scripts, arbitrary package URLs,
and packages outside the allowlist are rejected. The install phase has a short,
controlled network window; the subsequent student program runs with `--network none`.

Health check:

```bash
curl http://localhost:4001/health
```
