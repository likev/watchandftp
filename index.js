const chokidar = require('chokidar');
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

/**
 * Loads configuration from YAML (config.yaml / config.yml)
 */
function loadConfiguration() {
  const configFile = process.env.CONFIG_FILE ||
    (fs.existsSync('config.yaml') ? 'config.yaml' :
    (fs.existsSync('config.yml') ? 'config.yml' : null));

  if (!configFile || !fs.existsSync(configFile)) {
    console.error('[Config Error] Configuration file not found! Please create config.yaml (see config.example.yaml).');
    process.exit(1);
  }

  console.log(`[Config] Loading YAML configuration from ${configFile}...`);
  try {
    const raw = yaml.load(fs.readFileSync(configFile, 'utf8'));
    const defaults = raw.default || {};
    const rawTasks = Array.isArray(raw.tasks) && raw.tasks.length > 0 ? raw.tasks : [];

    if (rawTasks.length === 0) {
      console.warn(`[Config Warning] No tasks defined in ${configFile}.`);
    }

    return rawTasks.map((t, index) => {
      const merged = Object.assign({}, defaults, t);
      return {
        name: merged.name || `Task ${index + 1}`,
        enableWatchUpload: merged.enableWatchUpload !== false,
        useAtomicUpload: merged.useAtomicUpload === true,
        persistentConnection: merged.persistentConnection === true,
        connectionPools: parseInt(merged.connectionPools || '5', 10),
        includeHiddenFiles: merged.includeHiddenFiles === true,
        retryIfFail: merged.retryIfFail === true,
        retryTimes: parseInt(merged.retryTimes || '3', 10),
        watchDir: merged.watchDir || 'C:/path/to/local/dir',
        ftpHost: merged.ftpHost || 'ftp.example.com',
        ftpPort: parseInt(merged.ftpPort || '21', 10),
        ftpUser: merged.ftpUser || 'username',
        ftpPassword: String(merged.ftpPassword || 'password'),
        ftpRemoteDir: merged.ftpRemoteDir || '/remote/target/dir',
        secure: merged.ftpSecure === true,
        ftpTimeout: parseInt(merged.ftpTimeout || '30000', 10),
        stabilityThreshold: parseInt(merged.stabilityThreshold || '2000', 10),
        pollInterval: parseInt(merged.pollInterval || '100', 10),
        maxAgeDays: parseFloat(merged.maxAgeDays || '1'),
        autoDeleteLocal: merged.autoDeleteLocal === true,
        autoDeleteRemote: merged.autoDeleteRemote === true,
        autoDeleteRecursive: merged.autoDeleteRecursive === true,
        cleanupIntervalMinutes: parseInt(merged.cleanupIntervalMinutes || '60', 10),
      };
    });
  } catch (err) {
    console.error(`[Config Error] Failed to parse ${configFile}:`, err.message);
    process.exit(1);
  }
}

/**
 * Connection Manager for handling reusable persistent connection pools with auto-reconnect
 */
class FtpConnectionManager {
  constructor(config) {
    this.config = config;
    this.pool = [];         // Array of { client, inUse: boolean }
    this.waitingQueue = []; // Array of promise resolvers waiting for a pool slot
  }

  /**
   * Helper to create and authenticate a new ftp.Client instance.
   * Catches connection errors internally and returns null on failure.
   */
  async _createClient() {
    try {
      const client = new ftp.Client();
      client.ftp.verbose = false;
      client.ftp.timeout = this.config.ftpTimeout || 30000;
      await client.access({
        host: this.config.ftpHost,
        port: this.config.ftpPort,
        user: this.config.ftpUser,
        password: this.config.ftpPassword,
        secure: this.config.secure,
      });
      return client;
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] [${this.config.name}] Connection Error: ${err.message}`);
      return null;
    }
  }

  async getClient() {
    // Mode 1: Per-File Stateless Connection (persistentConnection = false)
    if (!this.config.persistentConnection) {
      const client = await this._createClient();
      if (!client) throw new Error(`FTP connection failed to ${this.config.ftpHost}:${this.config.ftpPort}`);
      return { client, isShared: false, slot: null };
    }

    // Mode 2: Persistent Connection Pool (persistentConnection = true)
    while (true) {
      // 1. Check for an existing idle connection slot in the pool
      let slot = this.pool.find((s) => !s.inUse);

      if (slot) {
        slot.inUse = true;
        if (slot.client && !slot.client.closed) {
          try {
            await slot.client.send('NOOP', true);
            return { client: slot.client, isShared: true, slot };
          } catch (err) {
            console.log(`[${new Date().toLocaleTimeString()}] [${this.config.name}] Pool connection session expired. Re-authenticating...`);
            if (slot.client) slot.client.close();
            slot.client = null;
          }
        }

        // Re-authenticate idle slot
        slot.client = await this._createClient();
        if (!slot.client) {
          slot.inUse = false;
          throw new Error(`FTP re-authentication failed to ${this.config.ftpHost}:${this.config.ftpPort}`);
        }
        return { client: slot.client, isShared: true, slot };
      }

      // 2. Reserve slot synchronously if pool size < connectionPools
      const maxPoolSize = this.config.connectionPools || 5;
      if (this.pool.length < maxPoolSize) {
        slot = { client: null, inUse: true };
        this.pool.push(slot);

        console.log(`[${new Date().toLocaleTimeString()}] [${this.config.name}] Authenticating persistent connection pool slot (${this.pool.length}/${maxPoolSize})...`);
        const client = await this._createClient();

        if (!client) {
          const idx = this.pool.indexOf(slot);
          if (idx !== -1) this.pool.splice(idx, 1);
          throw new Error(`FTP connection failed to ${this.config.ftpHost}:${this.config.ftpPort}`);
        }

        slot.client = client;
        return { client: slot.client, isShared: true, slot };
      }

      // 3. Pool is full and all slots are in use: wait for a slot to be released
      await new Promise((resolve) => this.waitingQueue.push(resolve));
    }
  }

  releaseClient(clientInfo) {
    if (!clientInfo || !clientInfo.slot) return;
    clientInfo.slot.inUse = false;

    // Wake up next upload waiting for a pool connection slot
    if (this.waitingQueue.length > 0) {
      const nextResolver = this.waitingQueue.shift();
      nextResolver();
    }
  }
}

/**
 * Task Runner instance for managing a single dir-ftp pair
 */
class TaskRunner {
  constructor(config) {
    this.config = config;
    this.ftpManager = new FtpConnectionManager(config);
  }

  log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    if (type === 'error') {
      console.error(`[${timestamp}] [${this.config.name}] ${msg}`);
    } else {
      console.log(`[${timestamp}] [${this.config.name}] ${msg}`);
    }
  }

  uploadToFtp(filePath) {
    return this._executeUpload(filePath);
  }

  /**
   * Executes single file upload with optional atomic rename & retries
   */
  async _executeUpload(filePath) {
    const filename = path.basename(filePath);

    if (!this.config.includeHiddenFiles && filename.startsWith('.')) {
      return;
    }

    this.log(`File ready for upload: ${filename}`);

    const maxAttempts = this.config.retryIfFail ? (this.config.retryTimes + 1) : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let clientInfo;
      try {
        clientInfo = await this.ftpManager.getClient();
        const client = clientInfo.client;

        await client.ensureDir(this.config.ftpRemoteDir);

        const remoteFilePath = path.join(this.config.ftpRemoteDir, filename).replace(/\\/g, '/');

        if (this.config.useAtomicUpload) {
          const tempRemoteFilePath = `${remoteFilePath}.uploading`;
          const attemptLabel = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '';
          this.log(`Uploading temporary${attemptLabel}: ${filename}.uploading`);
          await client.uploadFrom(filePath, tempRemoteFilePath);
          await client.rename(tempRemoteFilePath, remoteFilePath);
          this.log(`SUCCESS: Uploaded & Renamed ${filename} -> ${this.config.ftpRemoteDir}`);
        } else {
          const attemptLabel = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '';
          this.log(`Uploading${attemptLabel}: ${filename}`);
          await client.uploadFrom(filePath, remoteFilePath);
          this.log(`SUCCESS: Uploaded ${filename} -> ${this.config.ftpRemoteDir}`);
        }

        // Upload succeeded - exit retry loop
        return;
      } catch (err) {
        this.log(`ERROR (attempt ${attempt}/${maxAttempts}): Failed to upload ${filename}: ${err.message}`, 'error');

        if (attempt < maxAttempts) {
          // Exponential backoff: 1 min, 2 min, 4 min, 8 min... (2^(attempt-1) minutes)
          const waitMinutes = Math.pow(2, attempt - 1);
          const waitMs = waitMinutes * 60 * 1000;
          this.log(`Retrying upload in ${waitMinutes} minute(s)...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      } finally {
        if (clientInfo) {
          if (clientInfo.isShared) {
            this.ftpManager.releaseClient(clientInfo);
          } else if (clientInfo.client) {
            clientInfo.client.close();
          }
        }
      }
    }
  }

  async cleanupLocalDirectory(dirPath, cutoffTime) {
    if (!fs.existsSync(dirPath)) return;

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!this.config.includeHiddenFiles && entry.name.startsWith('.')) {
          continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isFile()) {
            const stats = await fs.promises.stat(fullPath);
            if (stats.mtimeMs < cutoffTime) {
              await fs.promises.unlink(fullPath);
              const relPath = path.relative(this.config.watchDir, fullPath);
              this.log(`CLEANUP (Local): Deleted old file ${relPath} (age > ${this.config.maxAgeDays} days)`);
            }
          } else if (entry.isDirectory() && this.config.autoDeleteRecursive) {
            await this.cleanupLocalDirectory(fullPath, cutoffTime);
          }
        } catch (err) {
          this.log(`CLEANUP (Local Error) ${entry.name}: ${err.message}`, 'error');
        }
      }
    } catch (err) {
      this.log(`CLEANUP (Local Dir Error) ${dirPath}: ${err.message}`, 'error');
    }
  }

  async cleanupRemoteDirectory(client, currentRemoteDir, cutoffTime) {
    try {
      const list = await client.list(currentRemoteDir);
      for (const item of list) {
        if (item.name === '.' || item.name === '..') continue;
        if (!this.config.includeHiddenFiles && item.name.startsWith('.')) continue;

        const remoteFilePath = path.join(currentRemoteDir, item.name).replace(/\\/g, '/');

        if (item.isFile && item.modifiedAt) {
          const itemModifiedTime = new Date(item.modifiedAt).getTime();
          if (itemModifiedTime < cutoffTime) {
            await client.remove(remoteFilePath);
            this.log(`CLEANUP (Remote): Deleted old FTP file ${remoteFilePath} (age > ${this.config.maxAgeDays} days)`);
          }
        } else if (item.isDirectory && this.config.autoDeleteRecursive) {
          await this.cleanupRemoteDirectory(client, remoteFilePath, cutoffTime);
        }
      }
    } catch (err) {
      this.log(`CLEANUP (Remote Dir Error) ${currentRemoteDir}: ${err.message}`, 'error');
    }
  }

  async runCleanupJob() {
    this.log(`Starting scheduled cleanup scan...`);
    const cutoffTime = Date.now() - this.config.maxAgeDays * 24 * 60 * 60 * 1000;

    if (this.config.autoDeleteLocal) {
      await this.cleanupLocalDirectory(this.config.watchDir, cutoffTime);
    }

    if (this.config.autoDeleteRemote) {
      const client = new ftp.Client();
      client.ftp.verbose = false;
      client.ftp.timeout = this.config.ftpTimeout || 30000;
      try {
        await client.access({
          host: this.config.ftpHost,
          port: this.config.ftpPort,
          user: this.config.ftpUser,
          password: this.config.ftpPassword,
          secure: this.config.secure,
        });
        await client.ensureDir(this.config.ftpRemoteDir);
        await this.cleanupRemoteDirectory(client, this.config.ftpRemoteDir, cutoffTime);
      } catch (err) {
        this.log(`CLEANUP (Remote Access Error): ${err.message}`, 'error');
      } finally {
        client.close();
      }
    }
    this.log(`Cleanup scan complete.\n`);
  }

  start() {
    console.log(`===================================================`);
    console.log(`Task Name:           ${this.config.name}`);
    console.log(`Watch & Auto-Upload: ${this.config.enableWatchUpload ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Persistent Conn:     ${this.config.persistentConnection ? `ENABLED (Pool size: ${this.config.connectionPools})` : 'DISABLED'}`);
    console.log(`Atomic (.uploading): ${this.config.useAtomicUpload ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Include Hidden Files:${this.config.includeHiddenFiles ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Retry On Failure:    ${this.config.retryIfFail ? `ENABLED (${this.config.retryTimes} retries, 1m/2m/4m...)` : 'DISABLED'}`);
    console.log(`Local Watch Dir:     ${this.config.watchDir}`);
    console.log(`FTP Server:          ${this.config.ftpHost}:${this.config.ftpPort}`);
    console.log(`Remote Target Dir:   ${this.config.ftpRemoteDir}`);
    console.log(`Auto Delete Local:   ${this.config.autoDeleteLocal} (> ${this.config.maxAgeDays} days)`);
    console.log(`Auto Delete Remote:  ${this.config.autoDeleteRemote} (> ${this.config.maxAgeDays} days)`);
    console.log(`===================================================\n`);

    if (this.config.enableWatchUpload) {
      const watcherOptions = {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.config.stabilityThreshold,
          pollInterval: this.config.pollInterval,
        },
      };

      if (!this.config.includeHiddenFiles) {
        watcherOptions.ignored = (pathStr) => {
          const basename = path.basename(pathStr);
          return basename.startsWith('.') && basename !== '.';
        };
      }

      const watcher = chokidar.watch(this.config.watchDir, watcherOptions);
      watcher.on('add', (filePath) => this.uploadToFtp(filePath));
      watcher.on('change', (filePath) => this.uploadToFtp(filePath));
      watcher.on('error', (error) => this.log(`Watcher Error: ${error.message}`, 'error'));
      watcher.on('ready', () => this.log('Watcher active and monitoring for changes...\n'));
    }

    if (this.config.autoDeleteLocal || this.config.autoDeleteRemote) {
      this.runCleanupJob();
      setInterval(() => this.runCleanupJob(), this.config.cleanupIntervalMinutes * 60 * 1000);
    }
  }
}

// -------------------------------------------------------------
// Main Execution
// -------------------------------------------------------------

if (require.main === module) {
  console.log('--- Watch & FTP Auto-Uploader / Cleanup Service ---\n');
  const tasksConfig = loadConfiguration();
  console.log(`Loaded ${tasksConfig.length} task(s).\n`);

  tasksConfig.forEach((taskConfig) => {
    const runner = new TaskRunner(taskConfig);
    runner.start();
  });
}

module.exports = { TaskRunner, FtpConnectionManager, loadConfiguration };
