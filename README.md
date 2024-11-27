# Gemini Browser Agent

An AI-powered web browser automation tool that uses Google's Gemini Vision model to understand and interact with web pages through natural language commands.
This is a very raw release with many bugs. Use as a POC.

## Overview

Gemini Browser Agent is an Electron-based application that combines the power of Google's Gemini Vision model with browser automation. It allows users to control web browsing through natural language instructions while the AI visually interprets the page content and performs actions like clicking, typing, scrolling, and navigation just like Anthropics Claude, but worse!

## Key Features

- **Visual Understanding**: Uses Gemini Vision to analyze webpage screenshots and understand their layout and content
- **Natural Language Control**: Accepts plain text commands and translates them into browser actions
- **Intelligent Element Detection**: Identifies and interacts with webpage elements using visual coordinates
- **Multiple Action Support**:
  - Click on any visible element
  - Type text into forms
  - Scroll up/down with customizable amounts
  - Navigate back in history
  
- **API Key Management**:
  - Supports multiple Gemini API keys
  - Automatic key rotation on failures
  - Built-in rate limit handling
  
- **Visual Feedback**:
  - Real-time click markers
  - Command verification
  - Task completion confirmation
  - Chat-style interaction history

## Technical Features

- Built with Electron and Node.js
- Uses Google's Generative AI SDK
- Implements screenshot-based visual analysis
- Handles browser events and state management
- Supports zoom controls and window resizing

## Requirements

- Google Gemini API key(s)
- Node.js and npm
- Electron compatible system
