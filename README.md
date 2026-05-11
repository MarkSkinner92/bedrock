# Bedrock

Bedrock is a long-running deployment control service for the ISS300 simulator. It manages the production manifest repository and Docker Compose stack, and exposes a unified command/event API over both **Socket.IO** and **Redis pub/sub**. Both transports are fully equivalent — any command sent through one produces the same status events on both.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values.

| Variable | Required | Description |
|---|---|---|
| `GITHUB_REPO_URL` | Yes | Git remote URL of the manifest repository |
| `REPO_FS_LOCATION` | Yes | Absolute path where the repo is cloned on disk |
| `YAML_NAME` | Yes | Filename of the Docker Compose file inside the repo (e.g. `production.yaml`) |
| `HOST` | Yes | Interface to bind the HTTP/Socket.IO server (e.g. `0.0.0.0`) |
| `PORT` | Yes | Port to bind (e.g. `8080`) |
| `REDIS_URL` | No | Redis connection URL. Defaults to `redis://127.0.0.1:6379` |

Bedrock exits immediately on startup if any required variable is missing.

---

## Running

```bash
npm start
# or
node main.js
```

Bedrock is designed to never stop. Uncaught exceptions and unhandled rejections are logged but do not terminate the process.

---

## Architecture

```
Socket.IO client  ──┐
                    ├──▶  dispatch()  ──▶  routine  ──▶  emitter.emit(event, data)
Redis PUBLISH    ──┘                                           │
                                                               ├──▶  socket.io  (to calling client, or broadcast)
                                                               └──▶  Redis PUBLISH  bedrock:<event>
```

All responses are emitted on **both** transports simultaneously. When a command arrives via Socket.IO, responses go to that socket only. When a command arrives via Redis, responses are broadcast to all connected Socket.IO clients.

### Operation lock

Bedrock has a single global lock. Only one destructive operation (`list_tags`, `download_tag`, `soft_restart`, `download_tag_and_soft_restart`) can run at a time. A second command arriving while one is in progress receives an immediate `status` error event. `get_version` is read-only and never acquires the lock.

---

## Socket.IO API

Connect to `http://<HOST>:<PORT>` with a Socket.IO client.

### Commands (client → server)

All commands are Socket.IO event names. Payloads are plain values (not wrapped in objects).

#### `list_tags`

Fetches the latest tags from the manifest repository.

```js
socket.emit('list_tags');
```

No payload.

---

#### `download_tag`

Checks out a specific tag and pulls all Docker images declared in the Compose file.

```js
socket.emit('download_tag', 'v1.2.3');
```

| Argument | Type | Description |
|---|---|---|
| tag | `string` | The git tag to check out and pull |

---

#### `soft_restart`

Runs `docker compose up -d --remove-orphans` against the currently checked-out Compose file. Does not pull new images.

```js
socket.emit('soft_restart');
```

No payload.

---

#### `download_tag_and_soft_restart`

Combines `download_tag` and `soft_restart` in a single atomic operation.

```js
socket.emit('download_tag_and_soft_restart', 'v1.2.3');
```

| Argument | Type | Description |
|---|---|---|
| tag | `string` | The git tag to check out, pull, and start |

---

#### `get_version`

Returns the git tag currently checked out in the production repo. Read-only; never acquires the lock.

```js
socket.emit('get_version');
```

No payload.

---

### Events (server → client)

#### `status`

Emitted throughout all operations to report progress and terminal outcomes.

```js
socket.on('status', ({ status, tag, progress, reason }) => { ... });
```

| Field | Type | Present when |
|---|---|---|
| `status` | `string` | Always |
| `tag` | `string` | Operations that involve a tag |
| `progress` | `string` | Intermediate progress lines (git output, docker output) |
| `reason` | `string` | Error and failure statuses |

**Status values:**

| `status` | Meaning |
|---|---|
| `cloning` | Repo does not exist locally; clone has started |
| `cloning-complete` | Clone finished successfully |
| `repo-exists` | Repo already present; fetching latest refs |
| `downloading` | Git checkout of the requested tag is in progress |
| `pulling-containers` | `docker compose pull` is running; `progress` contains individual output lines |
| `pulling-containers-complete` | Image pull finished |
| `pulling-containers-failed` | `docker compose pull` failed; `reason` contains the error |
| `download-complete` | Checkout + pull both succeeded |
| `download-failed` | Checkout or tag validation failed; `reason` contains the error |
| `soft-restarting` | `docker compose up -d --remove-orphans` is running |
| `soft-restarting-complete` | Compose up finished |
| `error` | Unexpected or unrecoverable error; `reason` contains the message |

---

#### `tags`

Emitted once in response to `list_tags`. Contains all tags from the manifest repository, sorted newest-first by version.

```js
socket.on('tags', (tags) => {
  // tags: string[]  e.g. ['v1.3.0', 'v1.2.1', 'v1.2.0']
});
```

---

#### `version`

Emitted once in response to `get_version`.

```js
socket.on('version', ({ tag }) => {
  // tag: string | null
  // null means the repo has not been cloned yet, or HEAD is not on an exact tag
});
```

---

## Redis API

The Redis API is a direct mirror of the Socket.IO API. Commands are sent by publishing to a `bedrock:<command>` channel. Responses arrive on `bedrock:<event>` channels with JSON payloads.

Bedrock uses **two Redis connections**: a publisher (for outbound events) and a dedicated subscriber (for inbound commands). Both connect to `REDIS_URL` at startup. If Redis is unavailable, Socket.IO continues to work normally — publish calls are silently dropped until the connection is restored.

### Commands (PUBLISH to Bedrock)

All payloads are JSON-encoded. For commands with no argument, publish an empty string or any value — it is ignored.

| Channel | Payload | Equivalent socket.io |
|---|---|---|
| `bedrock:list_tags` | *(ignored)* | `socket.emit('list_tags')` |
| `bedrock:download_tag` | `"v1.2.3"` | `socket.emit('download_tag', 'v1.2.3')` |
| `bedrock:soft_restart` | *(ignored)* | `socket.emit('soft_restart')` |
| `bedrock:download_tag_and_soft_restart` | `"v1.2.3"` | `socket.emit('download_tag_and_soft_restart', 'v1.2.3')` |
| `bedrock:get_version` | *(ignored)* | `socket.emit('get_version')` |

**Examples (redis-cli):**

```bash
# List available tags
PUBLISH bedrock:list_tags ""

# Download and start version v1.2.3
PUBLISH bedrock:download_tag_and_soft_restart '"v1.2.3"'

# Query current running version
PUBLISH bedrock:get_version ""
```

### Events (SUBSCRIBE from Bedrock)

Subscribe to these channels to receive the same events described in the Socket.IO section above. All messages are JSON strings.

| Channel | Payload type | Description |
|---|---|---|
| `bedrock:status` | `{ status, tag?, progress?, reason? }` | Progress and outcome of all operations |
| `bedrock:tags` | `string[]` | Response to `list_tags` |
| `bedrock:version` | `{ tag: string \| null }` | Response to `get_version` |

**Example (redis-cli):**

```bash
SUBSCRIBE bedrock:status bedrock:tags bedrock:version
```

---

## Module structure

```
main.js              Entry point. HTTP server, Socket.IO setup, event loop.
lib/
  config.js          Env validation and CONFIG object.
  lock.js            Global operation lock (acquireLock / releaseLock).
  git.js             Git helpers: clone, fetch, checkout, getCurrentTag.
  docker.js          Docker helpers: compose pull, compose up.
  routines.js        Compound async routines + dispatch() router.
  emitter.js         createEmitter(target) — unified socket.io + Redis publisher.
  redis.js           Redis publisher client.
  subscriber.js      Redis subscriber client and command routing.
```
