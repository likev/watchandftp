const chokidar = require('chokidar');
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
require('dotenv').config();

/**
 * Loads configuration from YAML (config.yaml / config.yml) or falls back to .env
 */
function loadConfiguration() {
  const configFile = process.env.CONFIG_FILE ||
    (fs.existsSync('config.yaml') ? 'config.yaml' :
    (fs.existsSync('config.yml') ? 'config.yml' : null));

  if (configFile && fs.existsSync(configFile)) {
    console.log(`[Config] Loading YAML configuration from ${configFile}...`);
    try {
      const raw = yaml.load(fs.readFileSync(configFile, 'utf8'));
      const defaults = raw.default || {};
      const rawTasks = Array.isArray(raw.tasks) && raw.tasks.length > 0 ? raw.tasks : [];

      if (rawTasks.length === 0) {
        console.warn(`[Config Warning] No tasks found in ${configFile}.`);
      }

      return rawTasks.map((t, index) => {
        const merged = Object.assign({}, defaults, t);
        return {
          name: merged.name || `Task ${index + 1}`,
          enableWatchUpload: merged.enableWatchUpload !== false,
          useAtomicUpload: merged.useAtomicUpload === true,
          persistentConnection: merged.persistentConnection === true,
          includeHiddenFiles: merged.includeHiddenFiles === true,
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

  // Fallback to legacy single-task .env configuration
  console.log('[Config] Loading single task from .env configuration...');
  return [{
    name: 'Default Task',
    enableWatchUpload: process.env.ENABLE_WATCH_UPLOAD !== 'false',
    useAtomicUpload: process.env.USE_ATOMIC_UPLOAD === 'true',
    persistentConnection: process.env.PERSISTENT_CONNECTION === 'true',
    includeHiddenFiles: process.env.INCLUDE_HIDDEN_FILES === 'true',
    watchDir: process.env.WATCH_DIR || 'C:/path/to/local/dir',
    ftpHost: process.env.FTP_HOST || 'ftp.example.com',
    ftpPort: parseInt(process.env.FTP_PORT || '21', 10),
    ftpUser: process.env.FTP_USER || 'username',
    ftpPassword: process.env.FTP_PASSWORD || 'password',
    ftpRemoteDir: process.env.FTP_REMOTE_DIR || '/remote/target/dir',
    secure: process.env.FTP_SECURE === 'true',
    ftpTimeout: parseInt(process.env.FTP_TIMEOUT || '30000', 10),
    stabilityThreshold: parseInt(process.env.STABILITY_THRESHOLD || '2000', 10),
    pollInterval: parseInt(process.env.POLL_INTERVAL || '100', 10),
    maxAgeDays: parseFloat(process.env.MAX_AGE_DAYS || '1'),
    autoDeleteLocal: process.env.AUTO_DELETE_LOCAL === 'true',
    autoDeleteRemote: process.env.AUTO_DELETE_REMOTE === 'true',
    autoDeleteRecursive: process.env.AUTO_DELETE_RECURSIVE === 'true',
    cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '60', 10),
  }];
}

/**
 * Connection Manager for handling reusable persistent connections with auto-reconnect
 */
class FtpConnectionManager {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  async getClient() {
    // Mode 1: Per-File Stateless Connection (persistentConnection = false)
    if (!this.config.persistentConnection) {
      const newClient = new ftp.Client();
      newClient.ftp.verbose = false;
      newClient.ftp.timeout = this.config.ftpTimeout;
      await newClient.access({
        host: this.config.ftpHost,
        port: this.config.ftpPort,
        user: this.config.ftpUser,
        password: this.config.ftpPassword,
        secure: this.config.secure,
      });
      return { client: newClient, isShared: false };
    }

    // Mode 2: Reusable Persistent Connection (persistentConnection = true)
    if (this.client && !this.client.closed) {
      try {
        await this.client.send('NOOP', true);
        return { client: this.client, isShared: true };
      } catch (err) {
        console.log(`[${new Date().toLocaleTimeString()}] [${this.config.name}] Session expired/closed by server. Re-authenticating...`);
        this.client.close();
        this.client = null;
      }
    }

    // Connect fresh persistent client
    console.log(`[${new Date().toLocaleTimeString()}] [${this.config.name}] Authenticating persistent FTP connection...`);
    this.client = new ftp.Client();
    this.client.ftp.verbose = false;
    this.client.ftp.timeout = this.config.ftpTimeout;
    await this.client.access({
      host: this.config.ftpHost,
      port: this.config.ftpPort,
      user: this.config.ftpUser,
      password: this.config.ftpPassword,
      secure: this.config.secure,
    });
    return { client: this.client, isShared: true };
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

  async uploadToFtp(filePath) {
    const filename = path.basename(filePath);

    if (!this.config.includeHiddenFiles && filename.startsWith('.')) {
      return;
    }

    this.log(`File ready for upload: ${filename}`);

    let clientInfo;
    try {
      clientInfo = await this.ftpManager.getClient();
      const client = clientInfo.client;

      await client.ensureDir(this.config.ftpRemoteDir);

      const remoteFilePath = path.join(this.config.ftpRemoteDir, filename).replace(/\\/g, '/');

      if (this.config.useAtomicUpload) {
        const tempRemoteFilePath = `${remoteFilePath}.uploading`;
        this.log(`Uploading temporary: ${filename}.uploading`);
        await client.uploadFrom(filePath, tempRemoteFilePath);

        try {
          await client.rename(tempRemoteFilePath, remoteFilePath);
        } catch (renameErr) {
          try {
            await client.remove(remoteFilePath);
            await client.rename(tempRemoteFilePath, remoteFilePath);
          } catch (retryErr) {
            throw renameErr;
          }
        }
        this.log(`SUCCESS: Uploaded & Renamed ${filename} -> ${this.config.ftpRemoteDir}`);
      } else {
        await client.uploadFrom(filePath, remoteFilePath);
        this.log(`SUCCESS: Uploaded ${filename} -> ${this.config.ftpRemoteDir}`);
      }
    } catch (err) {
      this.log(`ERROR: Failed to upload ${filename}: ${err.message}`, 'error');
    } finally {
      if (clientInfo && !clientInfo.isShared && clientInfo.client) {
        clientInfo.client.close();
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
      client.ftp.timeout = this.config.ftpTimeout;
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
    console.log(`Persistent Conn:     ${this.config.persistentConnection ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Atomic (.uploading): ${this.config.useAtomicUpload ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Include Hidden Files:${this.config.includeHiddenFiles ? 'ENABLED' : 'DISABLED'}`);
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

console.log('--- Watch & FTP Auto-Uploader / Cleanup Service ---\n');
const tasksConfig = loadConfiguration();
console.log(`Loaded ${tasksConfig.length} task(s).\n`);

tasksConfig.forEach((taskConfig) => {
  const runner = new TaskRunner(taskConfig);
  runner.start();
});
