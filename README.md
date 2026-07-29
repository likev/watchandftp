# Watch & FTP Auto-Uploader (Node.js)

Monitors a local folder for newly created or modified files, waits until file writing is 100% finished, automatically uploads them to an FTP server, and optionally cleans up old files on local disk and/or the FTP server.

## Features
- **Atomic Temporary Uploads**: Option to upload files as `.uploading` and atomically rename them upon completion to prevent remote processes from reading partial uploads.
- **Modular Feature Toggles**: Independently enable/disable file watching/uploading, atomic uploads, and auto-deletion cleanup.
- **Cross-Platform**: Runs natively on **Windows 10**, **Linux**, **WSL**, and **macOS**.
- **Write Completion Handling**: Uses `chokidar`'s `awaitWriteFinish` to ensure files (from slow writes, big transfers, or WSL) are not uploaded while still 0 bytes or locked.
- **Auto-Delete Old Files**: Configurable automatic deletion of files older than $X$ days on local disk and/or FTP server.
- **FTPS Support**: Supports standard FTP (port 21) or FTPS (FTP over TLS).

---

## Configuration (`.env`)

Create a `.env` file in the project folder (copy from `.env.example`):

```bash
cp .env.example .env
```

### Configuration Options

| Setting | Default | Description |
| :--- | :--- | :--- |
| `ENABLE_WATCH_UPLOAD` | `true` | Set to `false` to disable file watching and uploading (standalone cleanup mode) |
| `USE_ATOMIC_UPLOAD` | `false` | Set to `true` to upload files as `filename.uploading` and atomically rename to `filename` when done |
| `WATCH_DIR` | `C:/path/to/local/dir` | Local folder to monitor for changes |
| `FTP_HOST` | `ftp.example.com` | FTP server hostname or IP address |
| `FTP_PORT` | `21` | FTP port (default: 21) |
| `FTP_USER` | `username` | FTP login username |
| `FTP_PASSWORD` | `password` | FTP login password |
| `FTP_REMOTE_DIR` | `/remote/target/dir` | Target directory on the FTP server |
| `FTP_SECURE` | `false` | Set to `true` for FTPS (FTP over TLS/SSL) |
| `FTP_TIMEOUT` | `30000` | Network socket timeout in milliseconds (default: `30000` ms / 30 seconds) |
| `STABILITY_THRESHOLD` | `2000` | Time (ms) file size must remain unchanged before uploading |
| `POLL_INTERVAL` | `100` | Polling frequency (ms) to check file size stability |
| `MAX_AGE_DAYS` | `1` | Age threshold in days (e.g. `1` or `0.5` for 12 hours) for auto-deletion |
| `AUTO_DELETE_LOCAL` | `false` | Set to `true` to automatically delete local files older than `MAX_AGE_DAYS` |
| `AUTO_DELETE_REMOTE` | `false` | Set to `true` to automatically delete FTP remote files older than `MAX_AGE_DAYS` |
| `CLEANUP_INTERVAL_MINUTES` | `60` | Frequency in minutes to run the cleanup job |

---

## Atomic Upload vs Direct Upload (`USE_ATOMIC_UPLOAD`)

Both modes will overwrite an existing file on the FTP server, but they handle the upload window differently:

| Behavior | `USE_ATOMIC_UPLOAD=false` (Direct Upload) | `USE_ATOMIC_UPLOAD=true` (Atomic Upload) |
| :--- | :--- | :--- |
| **Overwrites existing file?** | **Yes** (FTP `STOR` command automatically overwrites) | **Yes** (Renames over target file) |
| **State of file DURING upload** | File is **truncated to 0 bytes** and grows as data uploads. | Old file remains **100% intact and untouched** while `.uploading` transfers. |
| **Risk to remote readers** | **High**: If a remote script reads the file while uploading, it will read a partial/corrupted file. | **Zero**: Remote readers only see the complete file swap in 1 millisecond when upload finishes. |

---

## Quick Start / Usage

1. Navigate into the project directory:
   ```bash
   cd watchandftp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure your credentials:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

4. Start watching and uploading:
   ```bash
   npm start
   ```
