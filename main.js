const { app, BrowserWindow, ipcMain, dialog, webContents, screen } = require('electron')
const path = require('path')
const fs = require('fs/promises')
require('dotenv').config()

// Replace key management code at top with this enhanced version
const apiKeys = (process.env.GEMINI_KEYS || '').split(',')
  .filter(key => key.trim())
  .map((key, index) => ({
    key: key.trim(),
    index: index + 1
  }));

let currentKeyIndex = 0;

// Replace the getNextApiKey function with this enhanced version
async function getNextApiKey() {
  console.log('[DEBUG] Entered getNextApiKey');
  if (!apiKeys || apiKeys.length === 0) {
    console.error('[ERROR] No API keys available');
    return null;
  }

  try {
    const totalKeys = apiKeys.length;
    console.log(`[DEBUG] Total keys: ${totalKeys}`);
    // Ensure currentKeyIndex stays within bounds
    if (currentKeyIndex >= totalKeys) {
      currentKeyIndex = 0;
    }
    console.log(`[DEBUG] currentKeyIndex: ${currentKeyIndex}`);
    
    const key = apiKeys[currentKeyIndex].key;
    console.log(`[KEY] Rotating to Key ${apiKeys[currentKeyIndex].index}/${totalKeys} (index: ${currentKeyIndex})`);
    console.log(`[KEY] Next index will be: ${(currentKeyIndex + 1) % totalKeys}`);
    
    // Move to next key for subsequent calls
    currentKeyIndex = (currentKeyIndex + 1) % totalKeys;
    
    return key;
  } catch (error) {
    console.error('[KEY] Error in getNextApiKey:', error);
    return null;
  }
}

let mainWindow
const screenshotsDir = path.join(__dirname, 'screenshots')
let webviewWebContents = null
let screenshotWindow = null

async function setupScreenshotsDirectory() {
  try {
    await fs.rm(screenshotsDir, { recursive: true, force: true })
    await fs.mkdir(screenshotsDir, { recursive: true })
  } catch (error) {
    console.error('Error setting up screenshots directory:', error)
  }
}

function createWindow() {
  console.log('[DEBUG] Creating main application window');
  mainWindow = new BrowserWindow({
    width: 1200,  // Back to normal size
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false  // Disable web security
    }
  })

  mainWindow.webContents.on('did-attach-webview', (event, wc) => {
    webviewWebContents = wc
    
    // Set permissive settings for webview
    wc.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Access-Control-Allow-Origin': ['*']
        }
      })
    })
  })

  mainWindow.loadFile('index.html')

  // Modify mainWindow.webContents.on('did-finish-load')
  mainWindow.webContents.on('did-finish-load', async () => {
    console.log('[INIT] did-finish-load event triggered');
    console.log('[INIT] Setting up initial API key');
    const initialKey = await getNextApiKey();
    if (initialKey) {
      console.log('[INIT] Sending initial key to renderer');
      mainWindow.webContents.send('process-env', {
        API_KEY: initialKey,
        TOTAL_KEYS: apiKeys.length
      });
    } else {
      console.error('[INIT] No available API keys. Application cannot proceed.');
    }
  })
}

// Add this function after existing variables
function waitForWebviewReady() {
  console.log('[DEBUG] Waiting for webview to be ready');
  return new Promise((resolve) => {
    if (webviewWebContents) {
      console.log('[DEBUG] Webview is already ready');
      resolve();
    } else {
      mainWindow.webContents.once('did-attach-webview', (event, wc) => {
        console.log('[DEBUG] did-attach-webview event triggered');
        webviewWebContents = wc;
        resolve();
      });
    }
  });
}

// Add new IPC handlers before app.whenReady()
ipcMain.handle('save-processed-screenshot', async (event, imageData) => {
  try {
    // Convert base64 to buffer
    const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    const timestamp = Date.now();
    const filePath = path.join(screenshotsDir, `screenshot-processed-${timestamp}.png`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  } catch (error) {
    console.error('Error saving processed screenshot:', error);
    throw error;
  }
});

// Add new handler for temp screenshots
ipcMain.handle('save-temp-screenshot', async (event, buffer) => {
  const timestamp = Date.now();
  const filePath = path.join(screenshotsDir, `temp-${timestamp}.png`);
  await fs.writeFile(filePath, buffer);
  return filePath;
});

// Add new IPC handlers before app.whenReady()
ipcMain.handle('scroll-page', async (event, direction, amount) => {
  console.log(`[SCROLL] Scrolling ${direction} by ${amount}`);
  if (webviewWebContents) {
    try {
      await webviewWebContents.executeJavaScript(`
        window.scrollBy({
          top: ${direction === 'up' ? -amount : amount},
          behavior: 'smooth'
        });
      `);
      return true;
    } catch (error) {
      console.error('[SCROLL] Error:', error);
      return false;
    }
  }
  return false;
});

app.whenReady().then(async () => {
  console.log('[DEBUG] App is ready');
  await setupScreenshotsDirectory()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Simplify screenshot handler
ipcMain.handle('take-screenshot', async (event, url, zoomLevel) => {
  console.log('[DEBUG] ipcMain.handle("take-screenshot") called');
  try {
    await waitForWebviewReady();
    console.log('[SCREENSHOT] Capturing page with zoom level:', zoomLevel);
    const currentZoom = Math.pow(2, zoomLevel || 0); // Convert from zoom level to scale factor
    const image = await webviewWebContents.capturePage({
      scale: currentZoom
    });
    console.log('[SCREENSHOT] Screenshot captured successfully');
    return `data:image/png;base64,${image.toPNG().toString('base64')}`;
  } catch (error) {
    console.error('[SCREENSHOT] Screenshot error:', error);
    throw error;
  }
});

// Update the rotate-api-key handler
ipcMain.handle('rotate-api-key', async () => {
  console.log('[DEBUG] ipcMain.handle("rotate-api-key") called');
  try {
    console.log('[ROTATE] Starting key rotation');
    const nextKey = await getNextApiKey();
    if (!nextKey) {
      console.error('[ROTATE] No valid key available');
      throw new Error('No valid API key available');
    }
    console.log('[ROTATE] Key rotation completed successfully');
    return nextKey;
  } catch (error) {
    console.error('[ROTATE] Key rotation failed:', error);
    return null;
  }
});

// Update mark-key-failed handler
ipcMain.handle('mark-key-failed', async (event, failedKey, error) => {
  console.log('[DEBUG] ipcMain.handle("mark-key-failed") called');
  const keyData = apiKeys.find(k => k.key === failedKey);
  if (keyData) {
    console.log(`[FAIL] Key ${keyData.index}/${apiKeys.length} failed. Error: ${error}`);
    console.log('[FAIL] Current index before getting next key:', currentKeyIndex);
  } else {
    console.log('[FAIL] Failed key not found in apiKeys array');
  }
  const nextKey = await getNextApiKey();
  console.log('[FAIL] Next key obtained:', nextKey ? 'success' : 'failed');
  return nextKey;
});

// Add track-key-usage handler before app.on('before-quit')
ipcMain.handle('track-key-usage', (event, key) => {
  console.log('[DEBUG] ipcMain.handle("track-key-usage") called');
  const keyData = apiKeys.find(k => k.key === key);
  if (keyData) {
    console.log(`[USAGE] Key ${keyData.index}/${apiKeys.length} used`);
    console.log('[USAGE] Current index:', currentKeyIndex);
  } else {
    console.log('[USAGE] Key not found in apiKeys array');
  }
});

app.on('before-quit', () => {
  if (screenshotWindow) {
    screenshotWindow.destroy();
  }
});
