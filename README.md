# Watch & FTP Auto-Uploader (Node.js)

Monitors local folders for newly created or modified files, waits until file writing is 100% finished, automatically uploads them to FTP servers, and optionally cleans up old files on local disk and/or FTP servers.

## Features
- **Multi-Task & Multi-FTP Support**: Define multiple `watchDir` $\rightarrow$ `FTP` pairs in `config.yaml`.
- **Global Defaults & Task Inheritance**: Define `default:` options once in `config.yaml` and override per-task as needed.
- **Exclude Hidden Files**: Default filtering out of dotfiles (`.DS_Store`, `.env`, `.git`, etc.) with configurable toggle (`includeHiddenFiles`).
- **Recursive Cleanup Option**: Option to clean files in subdirectories recursively (`autoDeleteRecursive`).
- **Persistent Connection & Auto-Reconnect**: Optional reusable connection mode with automatic session recovery if server idle timeout occurs.
- **Atomic Temporary Uploads**: Option to upload files as `.uploading` and atomically rename them upon completion to prevent remote processes from reading partial uploads.
- **Cross-Platform**: Runs natively on **Windows 10**, **Linux**, **WSL**, and **macOS**.

---

## Configuration (`config.yaml`)

Create a `config.yaml` file in the project folder (copy from `config.example.yaml`):

```bash
cp config.example.yaml config.yaml
```

### Example `config.yaml`

```yaml
# Global default settings (inherited by all tasks unless overridden)
default:
  enableWatchUpload: true
  persistentConnection: false
  useAtomicUpload: true
  includeHiddenFiles: false
  ftpPort: 21
  ftpSecure: false
  ftpTimeout: 30000
  stabilityThreshold: 2000
  pollInterval: 100
  maxAgeDays: 1
  autoDeleteLocal: false
  autoDeleteRemote: false
  autoDeleteRecursive: false
  cleanupIntervalMinutes: 60

# Multi dir-ftp pairs / tasks
tasks:
  - name: "Task 1 - Web Assets"
    watchDir: "C:/path/to/local/dir1"
    ftpHost: "ftp.example.com"
    ftpPort: 21
    ftpUser: "username"
    ftpPassword: "password"
    ftpRemoteDir: "/remote/target/dir1"

  - name: "Task 2 - Data Sync"
    watchDir: "C:/path/to/local/dir2"
    ftpHost: "ftp.rxdwdsj.com"
    ftpPort: 2121
    ftpUser: "ftpuser"
    ftpPassword: "1qaz2wsx"
    ftpRemoteDir: "/test_upload"
    useAtomicUpload: true
    autoDeleteRemote: true
    maxAgeDays: 7
```

### Configuration Options Reference

| Option | Default | Description |
| :--- | :--- | :--- |
| `name` | `Task N` | Display name for the task log output |
| `enableWatchUpload` | `true` | Set to `false` to disable file watching and uploading for this task |
| `persistentConnection` | `false` | Set to `true` to reuse FTP connection session across uploads with auto-reconnect |
| `useAtomicUpload` | `false` | Set to `true` to upload files as `filename.uploading` and atomically rename when done |
| `includeHiddenFiles` | `false` | Set to `true` to include hidden dotfiles (`.DS_Store`, `.git`, etc.) |
| `watchDir` | — | Local directory to monitor for changes |
| `ftpHost` | — | FTP server hostname or IP address |
| `ftpPort` | `21` | FTP port |
| `ftpUser` | — | FTP login username |
| `ftpPassword` | — | FTP login password |
| `ftpRemoteDir` | — | Target remote directory on the FTP server |
| `ftpSecure` | `false` | Set to `true` for FTPS (FTP over TLS/SSL) |
| `ftpTimeout` | `30000` | Network socket inactivity timeout in ms (default: 30 seconds) |
| `stabilityThreshold` | `2000` | Time (ms) file size must remain unchanged before uploading |
| `pollInterval` | `100` | Polling frequency (ms) to check file size stability |
| `maxAgeDays` | `1` | Age threshold in days for auto-deletion |
| `autoDeleteLocal` | `false` | Set to `true` to automatically delete local files older than `maxAgeDays` |
| `autoDeleteRemote` | `false` | Set to `true` to automatically delete FTP remote files older than `maxAgeDays` |
| `autoDeleteRecursive` | `false` | Set to `true` to scan and clean files in subdirectories recursively |
| `cleanupIntervalMinutes` | `60` | Frequency in minutes to run the cleanup job |

*(Note: Legacy `.env` files are still supported as a single-task fallback if no `config.yaml` is present).*

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

3. Create your `config.yaml` file:
   ```bash
   cp config.example.yaml config.yaml
   # Edit config.yaml with your task settings
   ```

4. Start watching and uploading:
   ```bash
   npm start
   ```
