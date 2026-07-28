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

  // Path & FTP Configuration
  watchDir: process.env.WATCH_DIR || 'C:/path/to/local/dir',
  ftpHost: process.env.FTP_HOST || 'ftp.example.com',
  ftpPort: parseInt(process.env.FTP_PORT || '21', 10),
  ftpUser: process.env.FTP_USER || 'username',
  ftpPassword: process.env.FTP_PASSWORD || 'password',
  remoteDir: process.env.FTP_REMOTE_DIR || '/remote/target/dir',
  secure: process.env.FTP_SECURE === 'true', // true for FTPS (FTP over TLS)
  stabilityThreshold: parseInt(process.env.STABILITY_THRESHOLD || '2000', 10), // ms to wait for file size stabilization
  pollInterval: parseInt(process.env.POLL_INTERVAL || '100', 10),

  // Auto-Cleanup Configuration
  maxAgeDays: parseFloat(process.env.MAX_AGE_DAYS || '1'),
  autoDeleteLocal: process.env.AUTO_DELETE_LOCAL === 'true',
  autoDeleteRemote: process.env.AUTO_DELETE_REMOTE === 'true',
  cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '60', 10),
};

console.log('--- Watch & FTP Auto-Uploader / Cleanup Service ---');
console.log(`Watch & Auto-Upload:  ${CONFIG.enableWatchUpload ? 'ENABLED' : 'DISABLED'}`);
console.log(`Atomic (.uploading):  ${CONFIG.useAtomicUpload ? 'ENABLED' : 'DISABLED'}`);
console.log(`Local Watch Directory: ${CONFIG.watchDir}`);
console.log(`FTP Server:           ${CONFIG.ftpHost}:${CONFIG.ftpPort}`);
console.log(`Remote Target Dir:    ${CONFIG.remoteDir}`);
if (CONFIG.enableWatchUpload) {
  console.log(`Stability Threshold:  ${CONFIG.stabilityThreshold}ms`);
}
console.log(`Auto Delete Local:    ${CONFIG.autoDeleteLocal} (> ${CONFIG.maxAgeDays} days)`);
console.log(`Auto Delete Remote:   ${CONFIG.autoDeleteRemote} (> ${CONFIG.maxAgeDays} days)`);
if (CONFIG.autoDeleteLocal || CONFIG.autoDeleteRemote) {
  console.log(`Cleanup Interval:     Every ${CONFIG.cleanupIntervalMinutes} mins`);
}
console.log('---------------------------------------------------\n');

/**
 * Uploads a single file to the FTP server using basic-ftp
 */
async function uploadToFtp(filePath) {
  const filename = path.basename(filePath);
  console.log(`[${new Date().toLocaleTimeString()}] File ready for upload: ${filename}`);

  const client = new ftp.Client();
  client.ftp.verbose = false; // Set to true for detailed raw FTP command logging

  try {
    await client.access({
      host: CONFIG.ftpHost,
      port: CONFIG.ftpPort,
      user: CONFIG.ftpUser,
      password: CONFIG.ftpPassword,
      secure: CONFIG.secure,
    });

    // Ensure target remote directory exists and navigate into it
    await client.ensureDir(CONFIG.remoteDir);

    const remoteFilePath = path.join(CONFIG.remoteDir, filename).replace(/\\/g, '/');

    if (CONFIG.useAtomicUpload) {
      // Upload with temporary .uploading extension then atomic rename
      const tempRemoteFilePath = `${remoteFilePath}.uploading`;
      console.log(`[${new Date().toLocaleTimeString()}] Uploading temporary: ${filename}.uploading`);
      await client.uploadFile(filePath, tempRemoteFilePath);

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
      await client.uploadFile(filePath, remoteFilePath);
      console.log(`[${new Date().toLocaleTimeString()}] SUCCESS: Uploaded ${filename} -> ${CONFIG.remoteDir}`);
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] ERROR: Failed to upload ${filename}:`, err.message);
  } finally {
    client.close();
  }
}

/**
 * Deletes local files in watchDir older than CONFIG.maxAgeDays
 */
async function cleanupLocalFiles() {
  if (!fs.existsSync(CONFIG.watchDir)) return;
  const cutoffTime = Date.now() - CONFIG.maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const files = await fs.promises.readdir(CONFIG.watchDir);
    for (const file of files) {
      const fullPath = path.join(CONFIG.watchDir, file);
      try {
        const stats = await fs.promises.stat(fullPath);
        if (stats.isFile() && stats.mtimeMs < cutoffTime) {
          await fs.promises.unlink(fullPath);
          console.log(`[${new Date().toLocaleTimeString()}] CLEANUP (Local): Deleted old file ${file} (age > ${CONFIG.maxAgeDays} days)`);
        }
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] CLEANUP (Local Error): ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] CLEANUP (Local Dir Error):`, err.message);
  }
}

/**
 * Deletes remote files on FTP server older than CONFIG.maxAgeDays
 */
async function cleanupRemoteFiles() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
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
    const list = await client.list();

    for (const item of list) {
      // Check if it's a file and older than maxAgeDays
      if (item.isFile && item.modifiedAt) {
        const itemModifiedTime = new Date(item.modifiedAt).getTime();
        if (itemModifiedTime < cutoffTime) {
          const remoteFilePath = path.join(CONFIG.remoteDir, item.name).replace(/\\/g, '/');
          await client.remove(remoteFilePath);
          console.log(`[${new Date().toLocaleTimeString()}] CLEANUP (Remote): Deleted old FTP file ${item.name} (age > ${CONFIG.maxAgeDays} days)`);
        }
      }
    }
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
