const { ipcRenderer } = require('electron')
const { GoogleGenerativeAI } = require('@google/generative-ai')

let genAI;
let chat;
let totalKeys = 0;  
let isFirstInit = true;  
let currentMarkerPosition = null;  
let isTaskRunning = false;
let abortRequested = false;
let isPageLoading = false;
let chatHistory = [];

// Add a new variable to track current task info
let currentTaskContext = {
  userMessage: '',
  taskStarted: false
};

// Add at the top with other state variables
let currentTask = null; // Track the current task state

// Receive environment variables from main process
ipcRenderer.on('process-env', (event, env) => {
  totalKeys = env.TOTAL_KEYS;  
  if (!env.API_KEY) {
    console.error('No API key provided');
    return;
  }
  genAI = new GoogleGenerativeAI(env.API_KEY);
  initializeChat();
})

// Update initializeChat to include task instruction
async function initializeChat() {
  const model = genAI.getGenerativeModel({ model: "gemini-exp-1121", 
    systemInstruction: `You're an assistant that helps with web browsing tasks.
When shown a screenshot, describe what needs to be clicked or typed.
Use these formats only:
- !click "exact VERY verbose and LONG description of element to click"
- !type [text to type] (this can only type text in text fields. Buttons do not work)
- !back (if you need to go back)
- !scroll up [amount] or !scroll down [amount] (amount is optional, defaults to 300)
You can put your thoughts before the commands if you need to. However, use only one command per response.
For search boxes, first click them, then type the search term.
Always add your thoughts before a command. Be verbose in your descriptions of elements to interact with.
Remember to send [DONE] when the task is complete and you see a result.` 
  });
  
  chat = model.startChat({
    history: chatHistory
  });
}

// Update sendScreenshotToGemini to preserve task context
async function sendScreenshotToGemini(screenshot, message, isVerification = false) {
  console.log('[DEBUG] sendScreenshotToGemini called');
  try {
    const imagePart = imageToGenerativePart(screenshot);
    const currentUrl = urlInput.value;
    console.log('[DEBUG] Current URL:', currentUrl);

    const fullMessage = isVerification ? 
      'Is the user\'s task complete based on what you see in this screenshot? Answer with "[YES]" or "[NO]" only.' :
      `Original task: ${currentTaskContext.userMessage}\n\nCurrent URL: ${currentUrl}\n${message}`;
    console.log('[DEBUG] Full message to send:', fullMessage);

    const result = await chat.sendMessage([
      imagePart,
      { text: fullMessage }
    ]);
    console.log('[DEBUG] Received response from chat.sendMessage');

    await ipcRenderer.invoke('track-key-usage', genAI.apiKey);

    // Update preserved history
    if (result.response) {
      chatHistory.push({
        role: 'user',
        parts: [{ text: fullMessage }]
      });
      chatHistory.push({
        role: 'model',
        parts: [{ text: result.response.text() }]
      });
    } else {
      console.error('[ERROR] No response from chat.sendMessage');
    }

    return result;
  } catch (error) {
    console.error('[ERROR] sendScreenshotToGemini error:', error);
    const failedKey = genAI.apiKey || genAI.options.apiKey;
    console.log('[DEBUG] Marking key as failed:', failedKey);
    const newKey = await ipcRenderer.invoke('mark-key-failed', failedKey, error.message);
    
    if (newKey) {
      console.log('[DEBUG] Received new key:', newKey);
      genAI = new GoogleGenerativeAI(newKey);
      await initializeChat(); // This will now use preserved history
      // Immediate retry with new key
      return sendScreenshotToGemini(screenshot, message, isVerification);
    }
    throw error;
  }
}

// Add after chat initialization section
function imageToGenerativePart(base64Image) {
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
  return {
    inlineData: {
      data: base64Data,
      mimeType: 'image/png'
    },
  };
}

// Chat elements
const chatMessages = document.getElementById('chat-messages')
const chatInput = document.getElementById('chat-input')
const sendButton = document.getElementById('send-button')

// Add message to chat window
function addMessage(text, isUser) {
  console.log(`${isUser ? 'User' : 'Assistant'}: ${text}`);
  const messageDiv = document.createElement('div')
  messageDiv.className = `message ${isUser ? 'user-message' : 'bot-message'}`
  messageDiv.textContent = text
  chatMessages.appendChild(messageDiv)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

// Add these command handling functions after the other utility functions
async function executeCommand(text) {
  console.log('[DEBUG] executeCommand called with text:', text);
  const typeMatch = text.match(/!type \[([^\]]+)\]/);
  const clickTarget = text.match(/!click (?:the |on )?["'](.+?)["']/i);
  const backCommand = text.match(/!back/i);
  const scrollMatch = text.match(/!scroll (up|down)(?: (\d+))?/i);

  if (scrollMatch) {
    console.log('[DEBUG] Found !scroll command:', scrollMatch[1]);
    const direction = scrollMatch[1].toLowerCase();
    const amount = parseInt(scrollMatch[2]) || 300; // Default scroll amount
    await ipcRenderer.invoke('scroll-page', direction, amount);
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete
    return;
  }

  if (typeMatch) {
    console.log('[DEBUG] Found !type command:', typeMatch[1]);
    await simulateTyping(typeMatch[1]);
    return;
  }

  if (clickTarget) {
    console.log('[DEBUG] Found !click command:', clickTarget[1]);
    await waitForPageLoad();
    console.log('[DEBUG] Page load awaited for click command');
    const screenshotData = await ipcRenderer.invoke('take-screenshot', null, webview.getZoomLevel());
    console.log('[DEBUG] Screenshot taken for click command');

    const coords = await getCoordinatesFromGemini(screenshotData, clickTarget[1]);
    console.log('[DEBUG] Coordinates from Gemini:', coords);
    
    if (coords) {
      const webviewRect = webview.getBoundingClientRect();
      const clickPos = calculateClickPosition(coords, webviewRect.width, webviewRect.height);
      console.log('[DEBUG] Click position calculated:', clickPos);
      showClickMarker(clickPos.x, clickPos.y, clickTarget[1]);
      await simulateClick(clickPos.x, clickPos.y);
    } else {
      console.error('[ERROR] No coordinates found for target:', clickTarget[1]);
    }
  }

  if (backCommand) {
    console.log('[DEBUG] Found !back command');
    if (webview.canGoBack()) {
      webview.goBack();
      await waitForPageLoad();
    } else {
      console.log('[DEBUG] Cannot go back - no history');
    }
    return;
  }

  if (!typeMatch && !clickTarget && !backCommand && !scrollMatch) {
    console.error('[ERROR] No valid command found in assistant response');
  }
}

// Update getCoordinatesFromGemini to not affect main chat history
async function getCoordinatesFromGemini(screenshot, targetDescription) {
  // Create separate chat instance for coordinates to not pollute main history
  const model = genAI.getGenerativeModel({ model: "gemini-exp-1121" });
  const coordinateChat = model.startChat();
  
  try {
    const imagePart = imageToGenerativePart(screenshot);
    const result = await coordinateChat.sendMessage([
      imagePart,
      { text: `Find this exact element: "${targetDescription}". Reply ONLY with the bounding box in format [ymin, xmin, ymax, xmax] (values 0-1000).` }
    ]);
    
    // Track successful API call
    await ipcRenderer.invoke('track-key-usage', genAI.apiKey);
    
    const coords = parseBoxCoordinates(result.response.text());
    if (!coords) throw new Error('Invalid coordinate response');
    return coords;
  } catch (error) {
    if (error.message.includes('429') || error.message.includes('quota')) {
      const failedKey = genAI.apiKey || genAI.options.apiKey;
      const newKey = await ipcRenderer.invoke('mark-key-failed', failedKey, error.message);
      
      if (newKey) {
        genAI = new GoogleGenerativeAI(newKey);
        // Immediate retry with new key
        return getCoordinatesFromGemini(screenshot, targetDescription);
      }
    }
    throw error;
  } finally {
    // No need to clean history since this is a separate chat instance
    coordinateChat.history = [];
  }
}

// Speed optimization: Reduce timeouts in click/type simulations
async function simulateClick(x, y) {
  const webviewRect = webview.getBoundingClientRect();
  const scaleFactor = window.devicePixelRatio || 1;

  const clickX = x * currentZoom;
  const clickY = y * currentZoom;

  webview.sendInputEvent({
    type: 'mouseDown',
    x: clickX,
    y: clickY,
    button: 'left',
    clickCount: 1
  });

  await new Promise(resolve => setTimeout(resolve, 25)); // Reduced from 50ms

  webview.sendInputEvent({
    type: 'mouseUp',
    x: clickX,
    y: clickY,
    button: 'left',
    clickCount: 1
  });

  return new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 200ms
}

async function simulateTyping(text) {
  for (const char of text) {
    webview.sendInputEvent({
      type: 'char',
      keyCode: char
    });
    await new Promise(resolve => setTimeout(resolve, 25)); // Reduced from 50ms
  }
  return new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 200ms
}

// Update continueTaskUntilDone with better state management
async function continueTaskUntilDone() {
  if (!currentTask || currentTask.aborted || abortRequested) {
    throw new Error('Task aborted or invalid');
  }

  try {
    // Add timeout to prevent infinite loops

    await waitForPageLoad();
    const rawScreenshotData = await ipcRenderer.invoke('take-screenshot', null, webview.getZoomLevel());

    if (!rawScreenshotData) {
      throw new Error('Failed to capture screenshot');
    }

    await ipcRenderer.invoke('save-processed-screenshot', rawScreenshotData);
    const currentUrl = urlInput.value;
    
    const imagePart = imageToGenerativePart(rawScreenshotData);

    const lastMessage = chat?.history?.[chat.history.length - 1]?.text;
    const isDone = lastMessage && lastMessage.includes('[DONE]');

    if (isDone && !abortRequested) {
      try {
        const verifyResult = await sendScreenshotToGemini(rawScreenshotData, '', true);
        const verifyResponse = verifyResult.response.text();
        
        if (abortRequested) throw new Error('Task aborted during verification');
        
        console.log('Completion verification:', verifyResponse);
        addMessage('Verifying completion: ' + verifyResponse, false);

        if (verifyResponse.includes('[YES]')) {
          console.log('Task completed successfully');
          setButtonState(false);
          return;
        }
      } catch (error) {
        if (abortRequested) throw error;
        console.error('Verification failed:', error);
      }
      
      if (abortRequested) throw new Error('Task aborted');

      const result = await sendScreenshotToGemini(rawScreenshotData, 'The task is not complete yet.');
      
      if (abortRequested) throw new Error('Task aborted');
      
      const response = result.response.text();
      console.log('Assistant:', response);
      addMessage(response, false);
      
      await executeCommand(response);
    } else if (!abortRequested) {
      const result = await sendScreenshotToGemini(rawScreenshotData, 'What should be the next action? Remember write your thoughts before the command. Remember to include "[" "]", be verbose in your descriptions of elements to click.');
      
      if (abortRequested) throw new Error('Task aborted');
      
      const response = result.response.text();
      console.log('Assistant:', response);
      addMessage(response, false);
      
      await executeCommand(response);
    }

    
    if (!abortRequested && !currentTask.aborted) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await continueTaskUntilDone();
    }

  } catch (error) {
    console.error('Task continuation error:', error);
    if (!error.message.includes('aborted')) {
      addMessage(`Error: ${error.message}`, false);
    }
    throw error;
  }
}

// Add after other utility functions
function setButtonState(running) {
  const button = document.getElementById('send-button');
  button.textContent = running ? 'Abort' : 'Send';
  button.classList.toggle('aborting', running);
  isTaskRunning = running;

  if (!running) {
    currentTask = null; // Reset currentTask when task ends
  }
}

// Add a function to abort the current task
function abortCurrentTask(reason) {
  if (currentTask && !currentTask.aborted) {
    currentTask.aborted = true;
    console.log('Task aborted:', reason);
    addMessage(`Task aborted: ${reason}`, false);
    setButtonState(false);
  }
}

// Replace sendMessage function with better error handling
async function sendMessage() {
  console.log('[DEBUG] sendMessage called');
  if (isTaskRunning) {
    abortRequested = true;
    console.log('[DEBUG] Abort requested by user');
    setButtonState(false);
    return;
  }

  const message = chatInput.value.trim();
  if (!message) {
    console.warn('[WARN] Empty message, returning');
    return;
  }

  // Set new task context
  currentTaskContext = {
    userMessage: message,
    taskStarted: true
  };

  chatHistory = []; // Clear history for new task
  setButtonState(true);
  abortRequested = false;

  // Initialize currentTask
  currentTask = {
    aborted: false
  };

  console.log('---New chat interaction---');
  console.log('User:', message);
  addMessage(message, true);
  chatInput.value = '';

  console.log('[DEBUG] Taking initial screenshot...');
  await waitForPageLoad();
  console.log('[DEBUG] Page load completed, about to capture screenshot');
  const rawScreenshotData = await ipcRenderer.invoke('take-screenshot', null, webview.getZoomLevel());
  console.log('[DEBUG] Screenshot data received:', rawScreenshotData ? 'success' : 'failure');

  if (!rawScreenshotData) {
    console.error('[ERROR] Failed to capture initial screenshot');
    setButtonState(false);
    return;
  }

  console.log('[DEBUG] Saving processed screenshot');
  await ipcRenderer.invoke('save-processed-screenshot', rawScreenshotData);

  const currentUrl = urlInput.value;
  console.log('[DEBUG] Current URL:', currentUrl);

  let attempts = 0;
  const maxAttempts = totalKeys;

  while (attempts < maxAttempts) {
    try {
      if (abortRequested) {
        console.log('[DEBUG] Task aborted by user');
        addMessage('Task aborted by user', false);
        setButtonState(false);
        break;
      }

      console.log(`[DEBUG] Sending screenshot to Gemini, attempt ${attempts + 1}`);
      const result = await sendScreenshotToGemini(rawScreenshotData, message);
      console.log('[DEBUG] Received response from Gemini');
      const response = result.response.text();
      
      console.log('Assistant:', response);
      addMessage(response, false);

      await executeCommand(response);
      
      if (!response.includes('[DONE]')) {
        console.log('[DEBUG] Task not done, continuing');
        await new Promise(resolve => setTimeout(resolve, 1000));
        await continueTaskUntilDone();
      } else {
        console.log('[DEBUG] Task completed');
      }
      
      return;
      
    } catch (error) {
      if (abortRequested) {
        console.log('[DEBUG] Task aborted by user during sendMessage');
        addMessage('Task aborted by user', false);
        setButtonState(false);
        break;
      }
      console.error(`[ERROR] Attempt ${attempts + 1} failed:`, error);
      attempts++;
      
      const failedKey = genAI.apiKey || genAI.options.apiKey;
      console.log('[DEBUG] Marking key as failed:', failedKey);
      const newKey = await ipcRenderer.invoke('mark-key-failed', failedKey, error.message);
      
      if (newKey) {
        console.log('[DEBUG] Retrying with new key');
        genAI = new GoogleGenerativeAI(newKey);
        await initializeChat();
      } else {
        console.error('[ERROR] No more keys available');
        break;
      }
    }
  }
  
  addMessage('All API keys exhausted. Please try again later.', false);
  setButtonState(false);
}

// Event listeners for chat
sendButton.addEventListener('click', sendMessage)
chatInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    sendMessage()
  }
})

// Browser elements
const webview = document.getElementById('webview')
const urlInput = document.getElementById('url-input')

// Initial page
webview.src = 'https://www.google.com'

// Remove or comment out the processScreenshot function as it's no longer needed
// window.processScreenshot = async (dataUrl, width, height) => { ... }

// Add these utility functions before the screenshot button event listener
async function drawGridOnImage(imageData, gridSize = 50) { // Increased from 30 to 50
  const canvas = document.getElementById('processing-canvas');
  const ctx = canvas.getContext('2d');
  
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      
      const centerX = Math.floor(canvas.width / 2);
      const centerY = Math.floor(canvas.height / 2);
      
      ctx.drawImage(img, 0, 0);
      
      ctx.lineWidth = 2; // Increased from 1 to 2
      ctx.font = 'bold 24px Arial'; // Increased from 14px to 24px
      
      ctx.strokeStyle = 'rgb(255, 0, 221)';
      for (let x = centerX % gridSize; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
        const coordX = Math.round((x - centerX) / gridSize);
        ctx.fillStyle = '#00ff00';
        ctx.fillText(coordX.toString(), x - 8, 25); // Adjusted position for larger font
      }
      
      ctx.strokeStyle = 'rgb(0, 255, 255)';
      for (let y = centerY % gridSize; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        const coordY = Math.round((y - centerY) / gridSize);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(coordY.toString(), 5, y + 8); // Adjusted position for larger font
      }
      
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = imageData;
  });
}

// Add these functions before the screenshot button event listener
// Update parseCoordinates to handle grid to screen conversion correctly
function parseCoordinates(text) {
  const match = text.match(/\[(-?\d+)\s*,\s*(-?\d+)\]/);
  if (match) {
    const xRel = parseInt(match[1]);
    const yRel = parseInt(match[2]);
    const gridSize = 50; // Update to match new grid size
    const x = xRel * gridSize;
    const y = yRel * gridSize;
    return { x, y };
  }
  return null;
}

function showClickMarker(x, y) {
  const browserContainer = document.getElementById('browser-container');
  const existingMarker = document.getElementById('click-marker');
  if (existingMarker) {
    existingMarker.remove();
  }

  const marker = document.createElement('div');
  marker.id = 'click-marker';
  
  const webviewRect = webview.getBoundingClientRect();
  const containerRect = browserContainer.getBoundingClientRect();
  const scaleFactor = window.devicePixelRatio || 1;

  const markerX = Math.round(webviewRect.left + (webviewRect.width / 2) + (x / scaleFactor) * currentZoom);
  const markerY = Math.round(webviewRect.top + (webviewRect.height / 2) + (y / scaleFactor) * currentZoom);

  Object.assign(marker.style, {
    position: 'fixed',
    left: `${markerX}px`,
    top: `${markerY}px`,
    width: '12px',
    height: '12px',
    backgroundColor: 'red',
    border: '2px solid white',
    borderRadius: '50%',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    zIndex: '999999',
    boxShadow: '0 0 4px rgba(0,0,0,0.5)'
  });

  document.body.appendChild(marker);
  currentMarkerPosition = { x, y };
}

// Replace the screenshot button event listener with this updated version
document.getElementById('screenshot-button').addEventListener('click', async () => {
  if (isTaskRunning) {
    abortRequested = true;
    return;
  }
  
  setButtonState(true);
  abortRequested = false;

  console.log('---Screenshot interaction---');
  let attempts = 0;
  const maxAttempts = totalKeys;

  while (attempts < maxAttempts) {
    try {
      const currentUrl = urlInput.value;
      await waitForPageLoad();
      let rawScreenshotData = await ipcRenderer.invoke('take-screenshot', currentUrl, webview.getZoomLevel());
      
      if (!rawScreenshotData && attempts === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        rawScreenshotData = await ipcRenderer.invoke('take-screenshot', currentUrl, webview.getZoomLevel());
      }
      
      if (!rawScreenshotData) {
        throw new Error('Failed to capture screenshot');
      }

      const processedImage = await drawGridOnImage(rawScreenshotData);
      await ipcRenderer.invoke('save-processed-screenshot', processedImage);

      if (!genAI || !chat) {
        throw new Error('API not initialized');
      }

      const imagePart = imageToGenerativePart(processedImage);
      const result = await chat.sendMessage([
        imagePart,
        { text: `Current URL: ${currentUrl}\nHere is a new screenshot. Analyze it and give the next command.` }
      ]);
      const response = result.response.text();
      console.log('Assistant:', response);
      addMessage(response, false);

      const coords = parseCoordinates(response);
      if (coords) {
        showClickMarker(coords.x, coords.y);
        await executeCommand(response);
      }

      if (!response.includes('[DONE]')) {
        await continueTaskUntilDone();
      }
      
      return;

    } catch (error) {
      if (abortRequested) {
        addMessage('Task aborted by user', false);
        break;
      }
      console.error(`Attempt ${attempts + 1} failed:`, error);
      attempts++;
      
      const failedKey = genAI.apiKey || genAI.options.apiKey;
      const newKey = await ipcRenderer.invoke('mark-key-failed', failedKey, error.message);
      
      if (newKey) {
        console.log(`Retrying with new key: ${newKey.substring(0, 8)}...`);
        genAI = new GoogleGenerativeAI(newKey);
        await initializeChat();
      } else {
        console.error('No more keys available');
        addMessage('All API keys exhausted. Please try again later.', false);
        break;
      }
    }
  }
  setButtonState(false);
});

// Add webview resize observer to update marker position
const resizeObserver = new ResizeObserver(() => {
  if (currentMarkerPosition) {
    showClickMarker(currentMarkerPosition.x, currentMarkerPosition.y);
  }
});

resizeObserver.observe(webview);

// Navigation controls
document.getElementById('back-button').addEventListener('click', () => {
  if (webview.canGoBack()) {
    webview.goBack()
  }
})

document.getElementById('forward-button').addEventListener('click', () => {
  if (webview.canGoForward()) {
    webview.goForward()
  }
})

document.getElementById('refresh-button').addEventListener('click', () => {
  webview.reload()
})

document.getElementById('go-button').addEventListener('click', () => {
  let url = urlInput.value
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }
  webview.loadURL(url)
})

// Update URL input when navigation occurs
webview.addEventListener('did-navigate', (event) => {
  urlInput.value = event.url
})

// Handle enter key in URL input
urlInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    document.getElementById('go-button').click()
  }
})

// Error handling
webview.addEventListener('did-fail-load', (event) => {
  console.error('Failed to load:', event)
})

// Add current URL context to chat messages
chatInput.addEventListener('focus', () => {
  const currentUrl = urlInput.value
  if (currentUrl && currentUrl !== 'about:blank') {
  }
})

// Update reset chat functionality to clear history
document.getElementById('reset-chat').addEventListener('click', async () => {
  chatMessages.innerHTML = '';
  chatHistory = []; // Clear preserved history
  
  try {
    await initializeChat();
    addMessage('Conversation reset. How can I help you?', false);
  } catch (error) {
    console.error('Error resetting chat:', error);
    addMessage('Failed to reset conversation. Please try again.', false);
  }
});

// Add after browser elements initialization
let currentZoom = 1.0;

// Add zoom controls
document.getElementById('zoom-in-button').addEventListener('click', () => {
  currentZoom += 0.1;
  webview.setZoomLevel(Math.log2(currentZoom));
});

document.getElementById('zoom-out-button').addEventListener('click', () => {
  currentZoom = Math.max(0.5, currentZoom - 0.1);
  webview.setZoomLevel(Math.log2(currentZoom));
});

// Replace parseCoordinates and related functions with new box handling
function parseBoxCoordinates(text) {
  const match = text.match(/\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]/);
  if (!match) return null;
  
  const [_, ymin, xmin, ymax, xmax] = match.map(Number);
  return { ymin, xmin, ymax, xmax };
}

function calculateClickPosition(box, imageWidth, imageHeight) {
  const x = ((box.xmin + box.xmax) / 2000) * imageWidth;
  const y = ((box.ymin + box.ymax) / 2000) * imageHeight;
  return { x, y };
}

function showClickMarker(x, y, label) {
  const browserContainer = document.getElementById('browser-container');
  const existingMarker = document.getElementById('click-marker');
  if (existingMarker) {
    existingMarker.remove();
  }

  const marker = document.createElement('div');
  marker.id = 'click-marker';
  
  const webviewRect = webview.getBoundingClientRect();
  const scaleFactor = window.devicePixelRatio || 1;

  const markerX = Math.round(webviewRect.left + x);
  const markerY = Math.round(webviewRect.top + y);

  Object.assign(marker.style, {
    position: 'fixed',
    left: `${markerX}px`,
    top: `${markerY}px`,
    padding: '2px 6px',
    backgroundColor: 'rgba(255, 0, 0, 0.8)',
    color: 'white',
    border: '2px solid white',
    borderRadius: '4px',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    zIndex: '999999',
    boxShadow: '0 0 4px rgba(0,0,0,0.5)',
    fontSize: '12px'
  });

  marker.textContent = '●';
  document.body.appendChild(marker);
  currentMarkerPosition = { x, y };
}

// Remove drawGridOnImage function as it's no longer needed

// Add utility function to draw bounding box on image
async function drawBoxOnImage(imageData, box, label) {
  const canvas = document.getElementById('processing-canvas');
  const ctx = canvas.getContext('2d');
  
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      
      ctx.drawImage(img, 0, 0);
      
      const x = (box.xmin / 1000) * canvas.width;
      const y = (box.ymin / 1000) * canvas.height;
      const width = ((box.xmax - box.xmin) / 1000) * canvas.width;
      const height = ((box.ymax - box.ymin) / 1000) * canvas.height;
      
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, width, height);
      
      if (label) {
        ctx.font = '16px Arial';
        ctx.fillStyle = 'white';
        ctx.fillRect(x, y - 20, ctx.measureText(label).width + 10, 20);
        ctx.fillStyle = 'red';
        ctx.fillText(label, x + 5, y - 5);
      }
      
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = imageData;
  });
}

// Add this function after the webview initialization
function waitForPageLoad() {
  console.log('[DEBUG] waitForPageLoad called');
  return new Promise((resolve) => {
    if (!isPageLoading) {
      console.log('[DEBUG] Page is not loading, resolving immediately');
      resolve();
      return;
    }

    const loadTimeout = setTimeout(() => {
      console.warn('[WARN] waitForPageLoad timed out');
      webview.removeEventListener('did-stop-loading', onStopLoading);
      isPageLoading = false;
      resolve();
    }, 5000); // Timeout after 10 seconds

    const onStopLoading = () => {
      clearTimeout(loadTimeout);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      console.log('[DEBUG] did-stop-loading event triggered');
      isPageLoading = false;
      setTimeout(() => {
        console.log('[DEBUG] Additional delay after did-stop-loading');
        resolve();
      }, 1000); // Ensure dynamic content has loaded
    };

    webview.addEventListener('did-stop-loading', onStopLoading);
  });
}

// Add these event listeners after other webview event listeners
webview.addEventListener('did-start-loading', () => {
  console.log('[DEBUG] Webview did-start-loading');
  isPageLoading = true;
});

webview.addEventListener('did-stop-loading', () => {
  console.log('[DEBUG] Webview did-stop-loading');
  isPageLoading = false;
});

