const chokidar = require('chokidar');
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Configuration (Reads from environment variables or defaults)
const CONFIG = {
  // Feature Toggles
  enableWatchUpload: process.env.ENABLE_WATCH_UPLOAD !== 'false', // Default: true
  useAtomicUpload: process.env.USE_ATOMIC_UPLOAD === 'true',     // Default: false (upload with .uploading extension then rename)
  persistentConnection: process.env.PERSISTENT_CONNECTION === 'true', // Default: false (reuse connection with auto-reconnect)

  // Path & FTP Configuration
  watchDir: process.env.WATCH_DIR || 'C:/path/to/local/dir',
  ftpHost: process.env.FTP_HOST || 'ftp.example.com',
  ftpPort: parseInt(process.env.FTP_PORT || '21', 10),
  ftpUser: process.env.FTP_USER || 'username',
  ftpPassword: process.env.FTP_PASSWORD || 'password',
  remoteDir: process.env.FTP_REMOTE_DIR || '/remote/target/dir',
  secure: process.env.FTP_SECURE === 'true', // true for FTPS (FTP over TLS)
  ftpTimeout: parseInt(process.env.FTP_TIMEOUT || '30000', 10), // Network timeout in ms (default: 30000ms / 30 seconds)
  stabilityThreshold: parseInt(process.env.STABILITY_THRESHOLD || '2000', 10), // ms to wait for file size stabilization
  pollInterval: parseInt(process.env.POLL_INTERVAL || '100', 10),

  // Auto-Cleanup Configuration
  maxAgeDays: parseFloat(process.env.MAX_AGE_DAYS || '1'),
  autoDeleteLocal: process.env.AUTO_DELETE_LOCAL === 'true',
  autoDeleteRemote: process.env.AUTO_DELETE_REMOTE === 'true',
  autoDeleteRecursive: process.env.AUTO_DELETE_RECURSIVE === 'true', // Default: false (clean files in subdirectories recursively)
  cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '60', 10),
};

console.log('--- Watch & FTP Auto-Uploader / Cleanup Service ---');
console.log(`Watch & Auto-Upload:  ${CONFIG.enableWatchUpload ? 'ENABLED' : 'DISABLED'}`);
console.log(`Persistent Connection:${CONFIG.persistentConnection ? 'ENABLED (Auto-Reconnect)' : 'DISABLED (Per-File Login)'}`);
console.log(`Atomic (.uploading):  ${CONFIG.useAtomicUpload ? 'ENABLED' : 'DISABLED'}`);
console.log(`Local Watch Directory: ${CONFIG.watchDir}`);
console.log(`FTP Server:           ${CONFIG.ftpHost}:${CONFIG.ftpPort}`);
console.log(`FTP Timeout:          ${CONFIG.ftpTimeout}ms (${CONFIG.ftpTimeout / 1000}s)`);
console.log(`Remote Target Dir:    ${CONFIG.remoteDir}`);
if (CONFIG.enableWatchUpload) {
  console.log(`Stability Threshold:  ${CONFIG.stabilityThreshold}ms`);
}
console.log(`Auto Delete Local:    ${CONFIG.autoDeleteLocal} (> ${CONFIG.maxAgeDays} days)`);
console.log(`Auto Delete Remote:   ${CONFIG.autoDeleteRemote} (> ${CONFIG.maxAgeDays} days)`);
if (CONFIG.autoDeleteLocal || CONFIG.autoDeleteRemote) {
  console.log(`Recursive Cleanup:    ${CONFIG.autoDeleteRecursive ? 'ENABLED (Includes Subdirectories)' : 'DISABLED (Top-level only)'}`);
  console.log(`Cleanup Interval:     Every ${CONFIG.cleanupIntervalMinutes} mins`);
}
console.log('---------------------------------------------------\n');

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
        // Send a lightweight NOOP command to verify if session is still alive
        await this.client.send('NOOP', true);
        return { client: this.client, isShared: true };
      } catch (err) {
        console.log(`[${new Date().toLocaleTimeString()}] Notice: Idle session expired/closed by server. Re-authenticating...`);
        this.client.close();
        this.client = null;
      }
    }

    // Connect fresh persistent client
    console.log(`[${new Date().toLocaleTimeString()}] Authenticating persistent FTP connection...`);
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

const ftpManager = new FtpConnectionManager(CONFIG);

/**
 * Uploads a single file to the FTP server using basic-ftp
 */
async function uploadToFtp(filePath) {
  const filename = path.basename(filePath);
  console.log(`[${new Date().toLocaleTimeString()}] File ready for upload: ${filename}`);

  let clientInfo;
  try {
    clientInfo = await ftpManager.getClient();
    const client = clientInfo.client;

    // Ensure target remote directory exists and navigate into it
    await client.ensureDir(CONFIG.remoteDir);

    const remoteFilePath = path.join(CONFIG.remoteDir, filename).replace(/\\/g, '/');

    if (CONFIG.useAtomicUpload) {
      // Upload with temporary .uploading extension then atomic rename
      const tempRemoteFilePath = `${remoteFilePath}.uploading`;
      console.log(`[${new Date().toLocaleTimeString()}] Uploading temporary: ${filename}.uploading`);
      await client.uploadFrom(filePath, tempRemoteFilePath);

      try {
        await client.rename(tempRemoteFilePath, remoteFilePath);
      } catch (renameErr) {
        // If target file already exists and server rejects direct overwrite on rename, remove target first
        try {
          await client.remove(remoteFilePath);
          await client.rename(tempRemoteFilePath, remoteFilePath);
        } catch (retryErr) {
          throw renameErr;
        }
      }
      console.log(`[${new Date().toLocaleTimeString()}] SUCCESS: Uploaded & Renamed ${filename} -> ${CONFIG.remoteDir}`);
    } else {
      // Direct upload
      await client.uploadFrom(filePath, remoteFilePath);
      console.log(`[${new Date().toLocaleTimeString()}] SUCCESS: Uploaded ${filename} -> ${CONFIG.remoteDir}`);
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] ERROR: Failed to upload ${filename}:`, err.message);
  } finally {
    // If persistent mode is disabled, close connection immediately
    if (clientInfo && !clientInfo.isShared && clientInfo.client) {
      clientInfo.client.close();
    }
  }
}

/**
 * Recursively scans and deletes local files in dirPath older than cutoffTime
 */
async function cleanupLocalDirectory(dirPath, cutoffTime, recursive) {
  if (!fs.existsSync(dirPath)) return;

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          const stats = await fs.promises.stat(fullPath);
          if (stats.mtimeMs < cutoffTime) {
            await fs.promises.unlink(fullPath);
            const relPath = path.relative(CONFIG.watchDir, fullPath);
            console.log(`[${new Date().toLocaleTimeString()}] CLEANUP (Local): Deleted old file ${relPath} (age > ${CONFIG.maxAgeDays} days)`);
          }
        } else if (entry.isDirectory() && recursive) {
          await cleanupLocalDirectory(fullPath, cutoffTime, recursive);
        }
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] CLEANUP (Local Error) ${entry.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] CLEANUP (Local Dir Error) ${dirPath}:`, err.message);
  }
}

/**
 * Deletes local files in watchDir older than CONFIG.maxAgeDays
 */
async function cleanupLocalFiles() {
  const cutoffTime = Date.now() - CONFIG.maxAgeDays * 24 * 60 * 60 * 1000;
  await cleanupLocalDirectory(CONFIG.watchDir, cutoffTime, CONFIG.autoDeleteRecursive);
}

/**
 * Recursively scans and deletes remote files on FTP server older than cutoffTime
 */
async function cleanupRemoteDirectory(client, currentRemoteDir, cutoffTime, recursive) {
  try {
    const list = await client.list(currentRemoteDir);
    for (const item of list) {
      if (item.name === '.' || item.name === '..') continue;
      const remoteFilePath = path.join(currentRemoteDir, item.name).replace(/\\/g, '/');

      if (item.isFile && item.modifiedAt) {
        const itemModifiedTime = new Date(item.modifiedAt).getTime();
        if (itemModifiedTime < cutoffTime) {
          await client.remove(remoteFilePath);
          console.log(`[${new Date().toLocaleTimeString()}] CLEANUP (Remote): Deleted old FTP file ${remoteFilePath} (age > ${CONFIG.maxAgeDays} days)`);
        }
      } else if (item.isDirectory && recursive) {
        await cleanupRemoteDirectory(client, remoteFilePath, cutoffTime, recursive);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] CLEANUP (Remote Dir Error) ${currentRemoteDir}:`, err.message);
  }
}

/**
 * Deletes remote files on FTP server older than CONFIG.maxAgeDays
 */
async function cleanupRemoteFiles() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.ftp.timeout = CONFIG.ftpTimeout;
  const cutoffTime = Date.now() - CONFIG.maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    await client.access({
      host: CONFIG.ftpHost,
      port: CONFIG.ftpPort,
      user: CONFIG.ftpUser,
      password: CONFIG.ftpPassword,
      secure: CONFIG.secure,
    });

    await client.ensureDir(CONFIG.remoteDir);
    await cleanupRemoteDirectory(client, CONFIG.remoteDir, cutoffTime, CONFIG.autoDeleteRecursive);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] CLEANUP (Remote Error):`, err.message);
  } finally {
    client.close();
  }
}

/**
 * Master cleanup job runner
 */
async function runCleanupJob() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting scheduled cleanup scan...`);
  if (CONFIG.autoDeleteLocal) {
    await cleanupLocalFiles();
  }
  if (CONFIG.autoDeleteRemote) {
    await cleanupRemoteFiles();
  }
  console.log(`[${new Date().toLocaleTimeString()}] Cleanup scan complete.\n`);
}

// -------------------------------------------------------------
// Initialization Logic
// -------------------------------------------------------------

// 1. Initialize File Watcher & Auto-Upload if enabled
if (CONFIG.enableWatchUpload) {
  const watcher = chokidar.watch(CONFIG.watchDir, {
    persistent: true,
    ignoreInitial: true, // Ignore existing files on initial startup
    awaitWriteFinish: {
      stabilityThreshold: CONFIG.stabilityThreshold,
      pollInterval: CONFIG.pollInterval,
    },
  });

  watcher.on('add', (filePath) => uploadToFtp(filePath));
  watcher.on('change', (filePath) => uploadToFtp(filePath));
  watcher.on('error', (error) => console.error('Watcher Error:', error));
  watcher.on('ready', () => {
    console.log('Watcher is active and monitoring for file changes...\n');
  });
} else {
  console.log('Notice: Watch & Auto-Upload is DISABLED (ENABLE_WATCH_UPLOAD=false).\n');
}

// 2. Initialize Auto-Cleanup if enabled
if (CONFIG.autoDeleteLocal || CONFIG.autoDeleteRemote) {
  runCleanupJob();
  setInterval(runCleanupJob, CONFIG.cleanupIntervalMinutes * 60 * 1000);
} else if (!CONFIG.enableWatchUpload) {
  console.log('WARNING: Both Watch/Upload and Auto-Delete features are disabled in configuration.');
}
