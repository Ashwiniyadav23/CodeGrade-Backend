# CodeGrade execution service

This service is the only component allowed to start student containers. It accepts JavaScript project files at `POST /execute` and runs them with Docker using:

- no network
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

Health check:

```bash
curl http://localhost:4001/health
```
