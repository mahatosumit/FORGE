// FORGE web console — high-fidelity AI Engineering Control Plane.
// Embedded single-page application served directly by the loopback API server.
// Interactive Conversational & Autonomous Engineering Harness (Cursor / Antigravity / Claude Code / Hermes parity).
// Includes Archify Architecture Intelligence, Plugin & Skill Marketplace, and Continuous Memory.

export function webConsoleHtml(token: string, port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FORGE — AI Engineering Control Plane</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-main: #070a12;
    --bg-sidebar: #05070d;
    --bg-card: #0d121f;
    --bg-card-hover: #131b2e;
    --bg-input: #0a0f1d;
    --border-subtle: #141c2e;
    --border-card: #1b263d;
    --border-glow: #2563eb40;
    --text-primary: #f1f5f9;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --accent-blue: #3b82f6;
    --accent-blue-glow: #60a5fa;
    --accent-purple: #8b5cf6;
    --accent-cyan: #06b6d4;
    --accent-green: #10b981;
    --accent-amber: #f59e0b;
    --accent-red: #ef4444;
    --sidebar-w: 290px;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 18px;
    --radius-full: 9999px;
    --font-sans: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, Consolas, monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    background: var(--bg-main);
    color: var(--text-primary);
    height: 100vh;
    display: flex;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #334155; }

  /* Layout */
  #sidebar {
    width: var(--sidebar-w);
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    z-index: 20;
    user-select: none;
  }

  #main-viewport {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100vh;
    position: relative;
    background: radial-gradient(circle at 50% 20%, #0d1527 0%, #070a12 70%);
    overflow: hidden;
  }

  /* Sidebar Header */
  .brand-header {
    padding: 1.25rem 1.25rem 1rem 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .brand-logo-lockup {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    text-decoration: none;
    cursor: pointer;
  }
  .logo-icon-svg {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    background: linear-gradient(135deg, #2563eb, #1d4ed8);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 16px rgba(37, 99, 235, 0.4);
  }
  .brand-name {
    font-size: 1.15rem;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #ffffff;
  }
  .brand-badge {
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.15rem 0.45rem;
    background: rgba(59, 130, 246, 0.15);
    color: var(--accent-blue-glow);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: var(--radius-full);
  }

  .btn-new-mission {
    margin: 0.5rem 1.25rem 1rem 1.25rem;
    background: linear-gradient(135deg, #2563eb, #3b82f6);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-md);
    padding: 0.65rem 1rem;
    font-size: 0.85rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
    transition: all 0.15s ease;
  }
  .btn-new-mission:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(37, 99, 235, 0.5);
  }

  .nav-section-title {
    padding: 0.5rem 1.25rem 0.35rem 1.25rem;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sidebar-nav-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0 0.75rem;
    overflow-y: auto;
    flex: 1;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.84rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .nav-item:hover {
    background: #0d1322;
    color: var(--text-primary);
  }
  .nav-item.active {
    background: #141f38;
    color: #ffffff;
    font-weight: 600;
  }
  .nav-item-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn-delete-mission {
    background: transparent;
    border: none;
    color: #475569;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .nav-item:hover .btn-delete-mission {
    opacity: 1;
  }
  .btn-delete-mission:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.15);
  }

  /* Status Dots */
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-verified { background: var(--accent-green); box-shadow: 0 0 8px rgba(16, 185, 129, 0.6); }
  .dot-running { background: var(--accent-blue); box-shadow: 0 0 8px rgba(59, 130, 246, 0.6); }
  .dot-blocked { background: var(--accent-amber); box-shadow: 0 0 8px rgba(245, 158, 11, 0.6); }
  .dot-failed { background: var(--accent-red); box-shadow: 0 0 8px rgba(239, 68, 68, 0.6); }

  /* Top Navigation Bar */
  #topbar {
    height: 56px;
    background: rgba(5, 7, 13, 0.7);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1.5rem;
    z-index: 10;
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pill-badge {
    background: #090e1a;
    border: 1px solid var(--border-card);
    border-radius: var(--radius-full);
    padding: 0.3rem 0.75rem;
    font-size: 0.76rem;
    font-weight: 600;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .pill-badge:hover {
    border-color: #2b3a5a;
    color: var(--text-primary);
  }
  .btn-icon-soft {
    background: #0d1322;
    border: 1px solid var(--border-card);
    color: var(--text-secondary);
    padding: 0.35rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    transition: all 0.15s;
  }
  .btn-icon-soft:hover {
    background: #151e36;
    color: var(--text-primary);
    border-color: #2b3c66;
  }

  /* Views Container */
  #hero-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    text-align: center;
  }
  .hero-box {
    max-width: 680px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
  }
  .hero-badge-pill {
    padding: 0.3rem 0.85rem;
    border-radius: var(--radius-full);
    background: rgba(37, 99, 235, 0.12);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: var(--accent-blue-glow);
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .hero-heading {
    font-size: 2.25rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.2;
    color: #ffffff;
  }
  .hero-subtitle {
    font-size: 0.95rem;
    color: var(--text-secondary);
    line-height: 1.6;
    max-width: 580px;
  }

  /* Mission View */
  #mission-view {
    flex: 1;
    display: none;
    flex-direction: column;
    height: calc(100vh - 56px);
    overflow: hidden;
  }
  .mission-header-bar {
    padding: 0.85rem 1.5rem;
    background: rgba(9, 13, 24, 0.85);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-shrink: 0;
  }
  .m-title-area {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    overflow: hidden;
  }
  .m-id-pill {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    background: #060913;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
  }
  .status-badge-lg {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .badge-running { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
  .badge-verified { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
  .badge-failed { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

  .tabs-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    padding: 0.35rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .tab-btn:hover {
    color: var(--text-primary);
    background: #0f1628;
  }
  .tab-btn.active {
    background: #141f38;
    color: #ffffff;
    border-color: #23355c;
  }

  .tab-pane {
    display: none;
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
    padding-bottom: 120px;
  }
  .tab-pane.active { display: block; }

  /* Clean Conversation Bubbles */
  .chat-turn {
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  }
  .chat-turn-user { align-items: flex-end; }
  .chat-turn-assistant { align-items: flex-start; }

  .user-bubble {
    background: linear-gradient(135deg, #1d4ed8, #2563eb);
    color: #ffffff;
    padding: 0.85rem 1.25rem;
    border-radius: var(--radius-lg) var(--radius-lg) 2px var(--radius-lg);
    font-size: 0.92rem;
    line-height: 1.5;
    max-width: 82%;
    box-shadow: 0 4px 16px rgba(37, 99, 235, 0.3);
  }

  .assistant-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 0.35rem;
  }
  .assistant-avatar {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: linear-gradient(135deg, #2563eb, #3b82f6);
    color: #ffffff;
    font-weight: 800;
    font-size: 0.72rem;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 10px rgba(37,99,235,0.4);
  }
  .assistant-name { color: #f8fafc; font-weight: 700; }
  .assistant-ts { color: var(--text-muted); font-size: 0.72rem; margin-left: auto; }

  .assistant-bubble {
    background: var(--bg-card);
    border: 1px solid var(--border-card);
    color: var(--text-primary);
    padding: 1.1rem 1.4rem;
    border-radius: 2px var(--radius-lg) var(--radius-lg) var(--radius-lg);
    font-size: 0.92rem;
    line-height: 1.65;
    max-width: 95%;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  }
  .assistant-bubble p { margin-bottom: 0.6rem; }
  .assistant-bubble p:last-child { margin-bottom: 0; }
  .assistant-bubble pre {
    background: #050811;
    border: 1px solid #141c2f;
    border-radius: var(--radius-sm);
    padding: 0.75rem 1rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: #e2e8f0;
    overflow-x: auto;
    margin: 0.75rem 0;
  }
  .assistant-bubble code {
    font-family: var(--font-mono);
    background: #101728;
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.84rem;
    color: #93c5fd;
  }

  .streaming-pill {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
    animation: pulseGlow 1.5s infinite alternate;
  }
  @keyframes pulseGlow {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  .streaming-cursor-pulse {
    display: inline-block;
    color: #3b82f6;
    font-weight: 900;
    margin-left: 3px;
    animation: blinkCursor 0.8s infinite;
  }
  @keyframes blinkCursor {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  .code-block-container {
    margin: 0.8rem 0;
    border: 1px solid #162035;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: #050811;
  }
  .code-block-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #090e1a;
    padding: 0.35rem 0.75rem;
    font-size: 0.72rem;
    color: #94a3b8;
    font-family: var(--font-mono);
    border-bottom: 1px solid #162035;
  }
  .code-copy-btn {
    background: transparent;
    border: 1px solid #1e293b;
    border-radius: 4px;
    color: #94a3b8;
    font-size: 0.68rem;
    padding: 0.12rem 0.45rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .code-copy-btn:hover {
    color: #fff;
    background: #1e293b;
  }

  /* Compact Collapsible Tool Invocations */
  .tool-compact-wrap {
    max-width: 900px;
    width: 100%;
    margin: 0.2rem auto;
  }
  .tool-compact-details {
    background: #080c16;
    border: 1px solid #162035;
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition: all 0.15s ease;
  }
  .tool-compact-details[open] {
    border-color: #2563eb55;
    background: #0a0f1c;
  }
  .tool-compact-summary {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.45rem 0.8rem;
    cursor: pointer;
    user-select: none;
    font-size: 0.78rem;
    color: #94a3b8;
  }
  .tool-compact-summary::-webkit-details-marker { display: none; }
  .tool-compact-summary:hover {
    color: #f1f5f9;
    background: rgba(255,255,255,0.02);
  }
  .tool-badge-pill {
    padding: 0.12rem 0.45rem;
    border-radius: 4px;
    background: #111a2e;
    color: #38bdf8;
    font-weight: 700;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid #1e2e4f;
  }
  .tool-summary-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: #cbd5e1;
  }
  .tool-expand-hint {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .tool-compact-body {
    padding: 0.65rem 0.85rem;
    border-top: 1px solid #141f36;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    background: #040710;
    color: #94a3b8;
  }
  .tool-compact-body pre {
    max-height: 180px;
    overflow-y: auto;
    margin-top: 0.25rem;
    padding: 0.4rem 0.6rem;
    background: #070a14;
    border: 1px solid #131b2c;
    border-radius: 4px;
    color: #cbd5e1;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .verdict-chip-line {
    max-width: 900px;
    width: 100%;
    margin: 0.15rem auto;
  }
  .verdict-inline-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.65rem;
    background: rgba(16, 185, 129, 0.08);
    border: 1px solid rgba(16, 185, 129, 0.25);
    border-radius: var(--radius-full);
    color: #34d399;
    font-size: 0.74rem;
    font-weight: 600;
  }
  .closure-chip-line {
    max-width: 900px;
    width: 100%;
    margin: 0.4rem auto;
    text-align: center;
  }
  .closure-inline-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.9rem;
    background: rgba(59, 130, 246, 0.12);
    border: 1px solid rgba(59, 130, 246, 0.35);
    border-radius: var(--radius-full);
    color: #93c5fd;
    font-size: 0.8rem;
    font-weight: 700;
  }

  /* Live Streaming Indicator */
  .streaming-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--accent-blue-glow);
    font-size: 0.82rem;
    font-weight: 600;
    margin: 0.5rem auto;
    max-width: 900px;
    width: 100%;
  }
  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-blue);
    animation: pulse 1.2s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(0.8); opacity: 0.5; }
    50% { transform: scale(1.3); opacity: 1; }
  }

  /* Bottom Floating Prompt Composer */
  .bottom-floating-bar-wrap {
    position: absolute;
    bottom: 1.25rem;
    left: 50%;
    transform: translateX(-50%);
    width: 92%;
    max-width: 880px;
    z-index: 25;
  }
  .prompt-composer-card {
    background: rgba(13, 19, 36, 0.95);
    border: 1px solid rgba(59, 130, 246, 0.45);
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.8), 0 0 24px rgba(59, 130, 246, 0.25);
    border-radius: var(--radius-lg);
    padding: 0.85rem 1.1rem 0.75rem 1.1rem;
    backdrop-filter: blur(18px);
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .input-upper-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .main-prompt-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 0.96rem;
    font-family: var(--font-sans);
  }
  .main-prompt-input::placeholder { color: #64748b; }

  .btn-submit-mission {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: linear-gradient(135deg, #2563eb, #3b82f6);
    border: 1px solid rgba(255,255,255,0.25);
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: 0 4px 14px rgba(37, 99, 235, 0.5);
    transition: all 0.15s;
  }
  .btn-submit-mission:hover { transform: scale(1.08); filter: brightness(1.2); }

  .input-lower-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 0.4rem;
    border-top: 1px solid rgba(255,255,255,0.06);
    font-size: 0.76rem;
  }
  .envelope-selector {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-muted);
  }
  .envelope-select-dropdown {
    background: #080c16;
    border: 1px solid #1b263e;
    color: #cbd5e1;
    font-size: 0.74rem;
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    outline: none;
  }

  /* Modals */
  .modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(8px);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal-overlay.open { display: flex; }
  .modal-window {
    background: #090e1c;
    border: 1px solid #1f2d4a;
    border-radius: var(--radius-lg);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
    width: 90%;
    max-width: 640px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .modal-header {
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid #17223b;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .modal-header h3 { font-size: 1.05rem; font-weight: 700; color: #ffffff; }
  .btn-close-modal {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 1.25rem;
    cursor: pointer;
  }
  .btn-close-modal:hover { color: #ffffff; }
  .modal-body {
    padding: 1.5rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* Plugin Marketplace Modal Window (Matching Screenshots) */
  .marketplace-modal-window {
    width: 94vw;
    max-width: 1080px;
    height: 88vh;
    background: #0c101d;
    border: 1px solid #1b263e;
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.9);
  }
  .marketplace-header {
    padding: 1.25rem 1.75rem 0.75rem 1.75rem;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
  }
  .marketplace-title-wrap h1 {
    font-size: 1.45rem;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: -0.01em;
  }
  .marketplace-title-wrap p {
    font-size: 0.84rem;
    color: #94a3b8;
    margin-top: 0.2rem;
  }
  .marketplace-top-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .btn-marketplace-action {
    background: #141b2c;
    border: 1px solid #202b44;
    color: #cbd5e1;
    border-radius: 8px;
    padding: 0.45rem 0.65rem;
    font-size: 0.8rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .btn-marketplace-action:hover { background: #1e2840; color: #ffffff; }
  .btn-marketplace-add {
    background: #ffffff;
    color: #0b0f19;
    border: none;
    font-weight: 700;
    padding: 0.45rem 0.85rem;
    border-radius: 8px;
    font-size: 0.82rem;
    cursor: pointer;
  }

  .marketplace-search-row {
    padding: 0.5rem 1.75rem 0.85rem 1.75rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .marketplace-search-input-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }
  .marketplace-search-input-wrap svg {
    position: absolute;
    left: 12px;
    color: #64748b;
  }
  .marketplace-search-input {
    width: 100%;
    background: #080c16;
    border: 1px solid #1a243a;
    border-radius: 8px;
    padding: 0.6rem 0.75rem 0.6rem 2.25rem;
    color: #f1f5f9;
    font-size: 0.86rem;
    outline: none;
  }
  .marketplace-search-input:focus { border-color: #3b82f6; }

  .marketplace-installed-section {
    padding: 0 1.75rem 1rem 1.75rem;
    border-bottom: 1px solid #162035;
  }
  .installed-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.6rem;
  }
  .installed-label { font-size: 0.86rem; font-weight: 600; color: #e2e8f0; }
  .installed-carousel-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    position: relative;
  }
  .carousel-scroll-arrow {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #141b2c;
    border: 1px solid #202b44;
    color: #94a3b8;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .carousel-scroll-arrow:hover { background: #1f2b45; color: #fff; }
  .installed-track {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    overflow-x: auto;
    scroll-behavior: smooth;
    padding: 0.2rem 0;
    flex: 1;
  }
  .installed-track::-webkit-scrollbar { display: none; }
  .installed-icon-pill {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
    font-size: 1.15rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.08);
    transition: transform 0.15s ease;
  }
  .installed-icon-pill:hover { transform: scale(1.1); }

  .marketplace-nav-tabs {
    display: flex;
    gap: 0.5rem;
    padding: 0.85rem 1.75rem 0.5rem 1.75rem;
  }
  .m-pill-btn {
    padding: 0.35rem 0.85rem;
    border-radius: var(--radius-full);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    color: #94a3b8;
    border: 1px solid transparent;
  }
  .m-pill-btn.active {
    background: #1c263c;
    color: #ffffff;
    border-color: #2a3857;
  }

  .marketplace-catalog-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 1.75rem 2rem 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }
  .marketplace-group-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 0.85rem;
  }
  .marketplace-cards-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.85rem;
  }
  @media (max-width: 900px) {
    .marketplace-cards-grid { grid-template-columns: 1fr; }
  }
  .plugin-card {
    background: #090d18;
    border: 1px solid #162035;
    border-radius: 10px;
    padding: 0.9rem 1rem;
    display: flex;
    align-items: flex-start;
    gap: 0.85rem;
    transition: all 0.15s ease;
  }
  .plugin-card:hover {
    border-color: #233252;
    background: #0d1322;
  }
  .plugin-card-icon {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    flex-shrink: 0;
    border: 1px solid rgba(255,255,255,0.1);
  }
  .plugin-card-info { flex: 1; min-width: 0; }
  .plugin-title-row { display: flex; align-items: center; gap: 0.5rem; }
  .plugin-name {
    font-size: 0.88rem;
    font-weight: 700;
    color: #ffffff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge-coding-plan {
    font-size: 0.65rem;
    padding: 0.12rem 0.45rem;
    border-radius: 4px;
    background: rgba(217, 119, 6, 0.2);
    color: #fbbf24;
    border: 1px solid rgba(217, 119, 6, 0.4);
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .plugin-desc {
    font-size: 0.76rem;
    color: #8896ab;
    margin-top: 0.3rem;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .plugin-card-action { flex-shrink: 0; margin-left: 0.5rem; }
  .btn-plugin-install {
    background: #141c2d;
    border: 1px solid #23304a;
    color: #e2e8f0;
    border-radius: 6px;
    padding: 0.35rem 0.75rem;
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-plugin-install:hover {
    background: #2563eb;
    border-color: #3b82f6;
    color: #ffffff;
  }
  .btn-plugin-installed {
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
  }
  .btn-plugin-installed:hover { color: #f1f5f9; background: #141c2d; }

  /* Architecture & Archify View */
  .archify-grid-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .stat-card {
    background: #090e1c;
    border: 1px solid #1a2744;
    border-radius: 10px;
    padding: 1rem;
  }
  .stat-card-label { font-size: 0.75rem; color: #8896ab; text-transform: uppercase; font-weight: 600; }
  .stat-card-val { font-size: 1.35rem; font-weight: 800; color: #ffffff; margin-top: 0.25rem; }
  .mermaid-box {
    background: #050811;
    border: 1px solid #141e33;
    border-radius: 12px;
    padding: 1.5rem;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: #cbd5e1;
    white-space: pre;
    line-height: 1.5;
  }

  /* Memory Items */
  .memory-card {
    background: #090d18;
    border: 1px solid #18233c;
    border-radius: 8px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .memory-top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .memory-badge {
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    background: #141f38;
    color: #60a5fa;
  }
</style>
</head>
<body>

<!-- Left Navigation Sidebar -->
<aside id="sidebar">
  <div class="brand-header">
    <div class="brand-logo-lockup" onclick="showHeroView()">
      <div class="logo-icon-svg">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
      </div>
      <span class="brand-name">FORGE</span>
      <span class="brand-badge">V1.1</span>
    </div>
  </div>

  <button class="btn-new-mission" onclick="showHeroView()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    <span>New Mission</span>
  </button>

  <div class="nav-section-title">
    <span>Conversations</span>
    <span id="missionsCountBadge" style="font-size:0.7rem; color:var(--text-muted);">0</span>
  </div>

  <div id="sidebarMissionsList" class="sidebar-nav-list">
    <!-- Populated dynamically with delete option -->
  </div>
</aside>

<!-- Main Viewport -->
<main id="main-viewport">
  <!-- Top Navigation Header -->
  <header id="topbar">
    <div class="topbar-left">
      <div class="pill-badge" onclick="openModal('modelsModal')" title="Configure active model and routing fallback">
        <span class="status-dot dot-verified"></span>
        <span id="topBarModelDisplay">NVIDIA NIM · llama-3.2-11b</span>
      </div>
      <div class="pill-badge" onclick="openModal('workspacesModal')" title="Switch or manage active workspace">
        <span class="status-dot dot-verified"></span>
        <span id="topBarWorkspaceDisplay">Workspace</span>
      </div>
      <div class="pill-badge" onclick="openModal('gitModal')" title="Git status and commit changes">
        <span id="gitCleanIndicator" class="status-dot dot-verified"></span>
        <span id="topBarGitBranch">Git: HEAD</span>
      </div>
    </div>
    <div class="topbar-right">
      <button class="btn-icon-soft" onclick="openModal('recoveryModal')" title="Inspect and recover interrupted missions">
        <span>🚑 Recovery</span>
      </button>
      <button class="btn-icon-soft" onclick="openMarketplaceModal()" title="Skill and plugin marketplace">
        <span>🧩 Marketplace</span>
      </button>
      <button class="btn-icon-soft" onclick="openMemoryModal()" title="Continuous memory and learned rules">
        <span>🧠 Memory</span>
      </button>
      <button class="btn-icon-soft" onclick="openModal('credentialsModal')" title="API credentials & keys manager">
        <span>🔑 Keys</span>
      </button>
      <button class="btn-icon-soft" onclick="openModal('skillsModal')" title="Governed capability host">
        <span>⚡ Capabilities</span>
      </button>
      <button class="btn-icon-soft" onclick="openModal('providersModal')" title="Manage LLM providers and connections">
        <span>⚙ Providers</span>
      </button>
    </div>
  </header>

  <!-- View 1: Hero Launcher View -->
  <div id="hero-view">
    <div class="hero-box">
      <div class="hero-badge-pill">Autonomous AI Engineering Substrate</div>
      <h1 class="hero-heading">What would you like FORGE to build or fix?</h1>
      <p class="hero-subtitle">
        Governed execution with mechanical verification. Models propose actions; the Authority Gate decides; capability host executes; tamper-evident cryptographic receipts prove what was achieved.
      </p>
    </div>
  </div>

  <!-- View 2: Live Mission View (Cursor / Claude Code / Antigravity Interactive Experience) -->
  <div id="mission-view">
    <div class="mission-header-bar">
      <div class="m-title-area">
        <span id="viewMissionId" class="m-id-pill">msn_000000</span>
        <span id="viewMissionStatus" class="status-badge-lg badge-running">RUNNING</span>
        <div style="font-weight:700; font-size:1rem; color:#fff;" id="viewMissionIntent">Mission Objective</div>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn active" onclick="switchTab('dialogue', this)">
          <span>💬 Conversation</span>
        </button>
        <button class="tab-btn" onclick="switchTab('architecture', this)">
          <span>🏗️ Architecture</span>
        </button>
        <button class="tab-btn" onclick="switchTab('gitdiff', this)">
          <span>Git Diff</span>
        </button>
        <button class="tab-btn" onclick="switchTab('evidence', this)">
          <span>Evidence</span>
        </button>
        <button class="tab-btn" onclick="switchTab('receipt', this)">
          <span>Receipt</span>
        </button>
      </div>
    </div>

    <!-- Tab 1: Clean Conversation & Execution Stream -->
    <div id="pane-dialogue" class="tab-pane active">
      <div id="escalationContainer" style="display:none; width:100%;"></div>
      <div id="dialogueCardsList" style="display:flex; flex-direction:column; gap:1.25rem; width:100%;"></div>
      <div id="liveStreamingIndicator" class="streaming-indicator" style="display:none;">
        <span class="pulse-dot"></span>
        <span id="liveStreamingText">FORGE agent is reasoning & executing...</span>
      </div>
    </div>

    <!-- Tab 2: Archify Architecture Tab -->
    <div id="pane-architecture" class="tab-pane">
      <div style="max-width:960px; width:100%; margin:0 auto; display:flex; flex-direction:column; gap:1.5rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <h2 style="font-size:1.25rem; font-weight:700; color:#ffffff;">Codebase Architecture Intelligence</h2>
            <p style="font-size:0.82rem; color:#94a3b8; margin-top:0.2rem;">Synthesized with Archify & Graphify engine for complete repository explainability</p>
          </div>
          <button class="btn-icon-soft" onclick="loadArchifyReport()">🔄 Rescan Repository</button>
        </div>
        <div id="archifyStatsRow" class="archify-grid-stats"></div>
        <div style="background:#090d1a; border:1px solid #18233c; border-radius:12px; padding:1.25rem;">
          <h3 style="font-size:0.95rem; font-weight:700; color:#fff; margin-bottom:0.75rem;">System Architecture Graph</h3>
          <pre id="archifyMermaidPre" class="mermaid-box"></pre>
        </div>
        <div id="archifySubsystemsWrap" style="display:flex; flex-direction:column; gap:1rem;"></div>
      </div>
    </div>

    <!-- Tab 3: Git Diff -->
    <div id="pane-gitdiff" class="tab-pane">
      <div style="max-width:900px; width:100%; margin:0 auto;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <h3 style="font-size:1rem; color:#ffffff;">Unified Working Tree Diff</h3>
          <button class="btn-icon-soft" onclick="refreshWorkspaceAndGit()">Refresh Diff</button>
        </div>
        <pre id="gitDiffContentBox" style="background:#040711; border:1px solid #141f38; border-radius:8px; padding:1rem; font-family:var(--font-mono); font-size:0.8rem; color:#cbd5e1; overflow-x:auto; white-space:pre; line-height:1.5;">No changes detected.</pre>
      </div>
    </div>

    <!-- Tab 4: Evidence Graph -->
    <div id="pane-evidence" class="tab-pane">
      <div id="evidenceContentBox" style="max-width:900px; width:100%; margin:0 auto; display:flex; flex-direction:column; gap:1rem;"></div>
    </div>

    <!-- Tab 5: Cryptographic Receipt -->
    <div id="pane-receipt" class="tab-pane">
      <div id="receiptContentBox" style="max-width:900px; width:100%; margin:0 auto;"></div>
    </div>
  </div>

  <!-- Bottom Floating Prompt Bar (Active across all screens) -->
  <div class="bottom-floating-bar-wrap">
    <div class="prompt-composer-card">
      <div class="input-upper-row">
        <input id="mainPromptInput" class="main-prompt-input" placeholder="Give an engineering task or prompt (e.g. Inspect the project, fix failing tests, add API)..." onkeydown="handleInputKey(event)" />
        <button class="btn-submit-mission" onclick="submitPrompt()" title="Submit Prompt">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
      <div class="input-lower-row">
        <div class="envelope-selector">
          <span>Authority:</span>
          <select id="authoritySelector" class="envelope-select-dropdown">
            <option value="safe-dev" selected>Safe Dev (Scoped Write & Tests)</option>
            <option value="read-only">Read-Only (Zero Side-Effects)</option>
            <option value="full-dev">Full Dev (Unrestricted Host)</option>
          </select>
          <span style="margin-left:0.5rem;">Verification:</span>
          <select id="verificationSelector" class="envelope-select-dropdown">
            <option value="standard" selected>Standard (Mechanical)</option>
            <option value="strict">Strict (Multi-Tier)</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</main>

<!-- Modals -->
<div id="modalOverlay" class="modal-overlay" onclick="if(event.target===this)closeModal()">
  <div id="standardModalWindow" class="modal-window">
    <div class="modal-header">
      <h3 id="modalTitle">Settings</h3>
      <button class="btn-close-modal" onclick="closeModal()">✕</button>
    </div>
    <div id="modalBody" class="modal-body"></div>
  </div>

  <!-- Plugin Marketplace Modal Window (Matching Screenshots) -->
  <div id="marketplaceModalWindow" class="marketplace-modal-window" style="display:none;">
    <div class="marketplace-header">
      <div class="marketplace-title-wrap">
        <h1>Plugin Marketplace</h1>
        <p>Extend FORGE with skills, commands, and MCP servers from plugins</p>
      </div>
      <div class="marketplace-top-actions">
        <button class="btn-marketplace-action" onclick="refreshMarketplace()" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
        </button>
        <button class="btn-marketplace-action" onclick="closeModal()" title="Close">✕</button>
      </div>
    </div>

    <!-- Search input -->
    <div class="marketplace-search-row">
      <div class="marketplace-search-input-wrap">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input id="marketplaceSearchInput" class="marketplace-search-input" placeholder="Search plugins..." oninput="filterPlugins(this.value)" />
      </div>
    </div>

    <!-- Installed Horizontal Carousel -->
    <div class="marketplace-installed-section">
      <div class="installed-header-row">
        <span class="installed-label">Installed</span>
        <button class="btn-marketplace-action" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="filterPublicPersonal('installed')">Installed Filter</button>
      </div>
      <div class="installed-carousel-container">
        <button class="carousel-scroll-arrow" onclick="scrollCarousel(-120)">‹</button>
        <div id="installedTrack" class="installed-track">
          <!-- Populated with colorful icon badges -->
        </div>
        <button class="carousel-scroll-arrow" onclick="scrollCarousel(120)">›</button>
      </div>
    </div>

    <!-- Public / Personal Tabs -->
    <div class="marketplace-nav-tabs">
      <button id="tabPublicBtn" class="m-pill-btn active" onclick="filterPublicPersonal('public')">Public</button>
      <button id="tabPersonalBtn" class="m-pill-btn" onclick="filterPublicPersonal('personal')">Personal</button>
    </div>

    <!-- Catalog Scrollable List with Groups -->
    <div id="marketplaceCatalogScroll" class="marketplace-catalog-scroll">
      <!-- Populated dynamically with Developer Tools, Productivity, Finance, Utilities -->
    </div>
  </div>
</div>

<script>
const TOKEN = "${token}";
let currentMissionId = null;
let allMissions = [];
let allProviders = [];
let currentConfig = null;
let isStreaming = false;
let allPlugins = [];
let currentMarketplaceTab = "public";

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "authorization": "Bearer " + TOKEN,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
}

let activeStreamText = "";

function scrollDialogueToBottom() {
  const pane = document.getElementById("pane-dialogue");
  if (pane) {
    pane.scrollTop = pane.scrollHeight;
  }
}

function showHeroView() {
  currentMissionId = null;
  localStorage.removeItem("forge_active_mission");
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("missionId");
    window.history.replaceState({}, "", u.toString());
  } catch {}
  document.getElementById("hero-view").style.display = "flex";
  document.getElementById("mission-view").style.display = "none";
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
}

function handleInputKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitPrompt();
  }
}

function ensureStreamingTurn() {
  let turn = document.getElementById("streamingTurn");
  if (!turn) {
    const container = document.getElementById("dialogueCardsList");
    const placeholder = container.querySelector('div[style*="text-align:center"]');
    if (placeholder) placeholder.remove();

    turn = document.createElement("div");
    turn.id = "streamingTurn";
    turn.className = "chat-turn chat-turn-assistant streaming-active";
    turn.innerHTML = \`
      <div class="assistant-header">
        <div class="assistant-avatar">F</div>
        <span class="assistant-name">FORGE</span>
        <span id="streamingStatusPill" class="streaming-pill">Thinking...</span>
        <span class="assistant-ts" id="streamingTurnTs">\${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="assistant-bubble" id="streamingBubbleContent">
        <span class="streaming-cursor-pulse">▌</span>
      </div>
    \`;
    container.appendChild(turn);
    scrollDialogueToBottom();
  }
  return turn;
}

function updateStreamingDelta(textChunk) {
  ensureStreamingTurn();
  activeStreamText += textChunk;
  const statusPill = document.getElementById("streamingStatusPill");
  if (statusPill) statusPill.textContent = "Generating...";

  const contentEl = document.getElementById("streamingBubbleContent");
  if (contentEl) {
    const formatted = formatMarkdown(activeStreamText);
    contentEl.innerHTML = (formatted || "") + '<span class="streaming-cursor-pulse">▌</span>';
  }
  scrollDialogueToBottom();
}

function handleToolProposal(proposal) {
  let shortCmd = "";
  if (proposal.args && typeof proposal.args === "object") {
    shortCmd = proposal.args.command || proposal.args.path || proposal.args.query || (proposal.args.argv ? proposal.args.argv.join(" ") : "");
  }
  const statusPill = document.getElementById("streamingStatusPill");
  if (statusPill) statusPill.textContent = \`Executing \${proposal.capability || "tool"}...\`;

  const container = document.getElementById("dialogueCardsList");
  const streamingTurn = document.getElementById("streamingTurn");
  const el = document.createElement("div");
  el.className = "tool-compact-wrap";
  const label = (proposal.capability || "TOOL").toUpperCase() + (shortCmd ? ": " + shortCmd : "");
  el.innerHTML = \`
    <details class="tool-compact-details" open>
      <summary class="tool-compact-summary">
        <span class="tool-badge-pill">⚙ \${escapeHtml(proposal.capability || "tool")}</span>
        <span class="tool-summary-text">\${escapeHtml(label)}</span>
        <span class="tool-expand-hint">inspect ▾</span>
      </summary>
      <div class="tool-compact-body">
        <div><b>Arguments:</b><pre>\${escapeHtml(JSON.stringify(proposal.args, null, 2))}</pre></div>
        <div style="margin-top:0.4rem;"><b>Status:</b> <span style="color:#60a5fa;">Running in runtime...</span></div>
      </div>
    </details>
  \`;
  if (streamingTurn) {
    container.insertBefore(el, streamingTurn);
  } else {
    container.appendChild(el);
  }
  activeStreamText = "";
  scrollDialogueToBottom();
}

function finalizeStreamingTurn(finalText) {
  const turn = document.getElementById("streamingTurn");
  if (turn) {
    const statusPill = document.getElementById("streamingStatusPill");
    if (statusPill) statusPill.remove();
    const contentEl = document.getElementById("streamingBubbleContent");
    if (contentEl) {
      const textToRender = finalText || activeStreamText;
      contentEl.innerHTML = formatMarkdown(textToRender);
    }
    turn.removeAttribute("id");
    turn.classList.remove("streaming-active");
  }
  activeStreamText = "";
  hideLiveStreamingIndicator();
}

async function submitPrompt() {
  const input = document.getElementById("mainPromptInput");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";

  if (currentMissionId) {
    appendUserBubble(text);
    ensureStreamingTurn();
    showLiveStreamingIndicator("FORGE agent is processing directive...");
    try {
      await api("POST", \`/missions/\${currentMissionId}/directive\`, { content: text });
    } catch (err) {
      alert("Error sending directive: " + err.message);
      hideLiveStreamingIndicator();
      finalizeStreamingTurn();
    }
    return;
  }

  showLiveStreamingIndicator("Starting new FORGE mission...");
  const authorityLevel = document.getElementById("authoritySelector").value;
  const verificationLevel = document.getElementById("verificationSelector").value;

  try {
    const res = await api("POST", "/missions", {
      intent: text,
      authorityLevel,
      verificationLevel,
    });
    const missionId = res.missionId;
    await refreshMissions();
    await selectMission(missionId);
    ensureStreamingTurn();
  } catch (err) {
    alert("Error starting mission: " + err.message);
    hideLiveStreamingIndicator();
    finalizeStreamingTurn();
  }
}

function appendUserBubble(text) {
  const container = document.getElementById("dialogueCardsList");
  const placeholder = container.querySelector('div[style*="text-align:center"]');
  if (placeholder) placeholder.remove();

  const turn = document.createElement("div");
  turn.className = "chat-turn chat-turn-user";
  turn.innerHTML = \`<div class="user-bubble">\${escapeHtml(text)}</div>\`;
  container.appendChild(turn);
  scrollDialogueToBottom();
}

function showLiveStreamingIndicator(msg) {
  isStreaming = true;
  const el = document.getElementById("liveStreamingIndicator");
  document.getElementById("liveStreamingText").textContent = msg;
  el.style.display = "flex";
  scrollDialogueToBottom();
}

function hideLiveStreamingIndicator() {
  isStreaming = false;
  document.getElementById("liveStreamingIndicator").style.display = "none";
}

async function selectMission(missionId) {
  currentMissionId = missionId;
  localStorage.setItem("forge_active_mission", missionId);
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("missionId", missionId);
    window.history.replaceState({ missionId }, "", u.toString());
  } catch {}

  document.getElementById("hero-view").style.display = "none";
  document.getElementById("mission-view").style.display = "flex";
  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.id === missionId);
  });
  await loadMissionDetails(missionId);
  await loadMissionDialogue(missionId);
}

async function deleteMission(e, missionId) {
  e.stopPropagation();
  if (!confirm("Are you sure you want to delete this chat session?")) return;
  try {
    await api("DELETE", \`/missions/\${missionId}\`);
    if (currentMissionId === missionId) {
      showHeroView();
    }
    await refreshMissions();
  } catch (err) {
    alert("Failed to delete mission: " + err.message);
  }
}

async function loadMissionDetails(missionId) {
  try {
    const summary = await api("GET", \`/missions/\${missionId}\`);
    const status = summary.status || "open";
    const goal = summary.goal || "(No goal stated)";

    document.getElementById("viewMissionId").textContent = missionId;
    document.getElementById("viewMissionIntent").textContent = goal;

    const statusBadge = document.getElementById("viewMissionStatus");
    statusBadge.className = "status-badge-lg " + (
      status === "closed" ? (summary.closure === "verified" ? "badge-verified" : "badge-failed") : "badge-running"
    );
    statusBadge.textContent = status.toUpperCase();

    // Check escalations
    const { pending } = await api("GET", \`/missions/\${missionId}/escalations\`);
    const escContainer = document.getElementById("escalationContainer");
    if (pending && pending.length > 0) {
      escContainer.style.display = "block";
      escContainer.innerHTML = pending.map(p => \`
        <div class="escalation-box" style="margin-bottom:1rem;">
          <div class="esc-title" style="color:#fbbf24; font-weight:700;">
            <span>⚠️ ESCALATION: Authority required for "\${escapeHtml(p.capability)}"</span>
          </div>
          <p style="font-size:0.85rem; color:#fef3c7;">\${escapeHtml(p.rationale || "Action exceeds current authority envelope.")}</p>
          <div style="font-family:var(--font-mono); font-size:0.75rem; background:#000; padding:0.5rem; border-radius:4px; margin:0.4rem 0;">\${escapeHtml(JSON.stringify(p.requested, null, 2))}</div>
          <div class="esc-actions-row">
            <button class="btn-extend" onclick="decideEscalation('\${missionId}', '\${p.requestId}', 'extend')">Approve (Grant Permission)</button>
            <button class="btn-deny" onclick="decideEscalation('\${missionId}', '\${p.requestId}', 'deny')">Deny Authority</button>
          </div>
        </div>
      \`).join("");
    } else {
      escContainer.style.display = "none";
    }

  } catch (err) {
    console.error("Failed to load mission details:", err);
  }
}

async function loadMissionDialogue(missionId) {
  try {
    const data = await api("GET", \`/missions/\${missionId}/dialogue\`);
    renderDialogue(data.dialogue || []);
  } catch (err) {
    console.error("Failed to load dialogue:", err);
  }
}

function renderDialogue(turns) {
  const container = document.getElementById("dialogueCardsList");
  container.innerHTML = "";

  if (!turns || turns.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; text-align:center; padding:2rem;">No conversation turns yet. Send a prompt to begin.</div>';
    return;
  }

  for (const t of turns) {
    if (t.type === "user") {
      const el = document.createElement("div");
      el.className = "chat-turn chat-turn-user";
      el.innerHTML = \`<div class="user-bubble">\${escapeHtml(t.text)}</div>\`;
      container.appendChild(el);
    } else if (t.type === "assistant") {
      const cleanContent = formatMarkdown(t.text);
      if (!cleanContent) continue;
      const el = document.createElement("div");
      el.className = "chat-turn chat-turn-assistant";
      el.innerHTML = \`
        <div class="assistant-header">
          <div class="assistant-avatar">F</div>
          <span class="assistant-name">FORGE</span>
          <span class="assistant-ts">\${formatTime(t.ts)}</span>
        </div>
        <div class="assistant-bubble">\${cleanContent}</div>
      \`;
      container.appendChild(el);
    } else if (t.type === "tool") {
      const el = document.createElement("div");
      el.className = "tool-compact-wrap";
      let shortCmd = "";
      if (t.args) {
        if (typeof t.args === "object") {
          shortCmd = t.args.command || t.args.path || t.args.query || (t.args.argv ? t.args.argv.join(" ") : "");
        }
      }
      const label = (t.tool || "TOOL").toUpperCase() + (shortCmd ? ": " + shortCmd : "");
      const obsText = t.observation ? JSON.stringify(t.observation, null, 2) : "Executed";
      el.innerHTML = \`
        <details class="tool-compact-details">
          <summary class="tool-compact-summary">
            <span class="tool-badge-pill">⚙ \${escapeHtml(t.tool || "tool")}</span>
            <span class="tool-summary-text">\${escapeHtml(label)}</span>
            <span class="tool-expand-hint">inspect ▾</span>
          </summary>
          <div class="tool-compact-body">
            <div><b>Arguments:</b><pre>\${escapeHtml(JSON.stringify(t.args, null, 2))}</pre></div>
            <div style="margin-top:0.4rem;"><b>Observation:</b><pre>\${escapeHtml(obsText)}</pre></div>
          </div>
        </details>
      \`;
      container.appendChild(el);
    } else if (t.type === "verdict") {
      const el = document.createElement("div");
      el.className = "verdict-chip-line";
      el.innerHTML = \`<span class="verdict-inline-chip">✔ \${escapeHtml(t.text)}</span>\`;
      container.appendChild(el);
    } else if (t.type === "closed") {
      const el = document.createElement("div");
      el.className = "closure-chip-line";
      el.innerHTML = \`<span class="closure-inline-chip">🛡️ \${escapeHtml(t.text)}</span>\`;
      container.appendChild(el);
    }
  }

  // Scroll to bottom
  const pane = document.getElementById("pane-dialogue");
  pane.scrollTop = pane.scrollHeight;
}

function copyCodeBlock(btn) {
  const pre = btn.closest('.code-block-container');
  const code = pre ? pre.querySelector('code') : null;
  if (!code) return;
  navigator.clipboard.writeText(code.innerText);
  btn.textContent = 'Copied!';
  setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
}

function formatMarkdown(text) {
  if (!text) return "";
  let clean = text;

  // 1. Strip raw proposal markdown code blocks (using \x60 for backtick)
  clean = clean.replace(/\x60\x60\x60(?:json)?\\s*[\\s\\S]*?\x60\x60\x60/gi, function(match) {
    if (/"proposal"|"capability"|"claim"|"rationale"/i.test(match)) {
      return "";
    }
    return match;
  });

  // 2. Strip raw JSON proposal residue
  clean = clean.replace(/\\{\\s*"(?:proposal|capability|claim)"[\\s\\S]*?\\n\\s*\\}/gi, "");
  clean = clean.replace(/\\{\\s*"(?:proposal|capability|claim)"[\\s\\S]*?\\}\\s*\\}\\s*\\}/gi, "");

  // 3. Strip robotic proposal narrations
  const narrations = [
    /Based on the recent ledger[^\\n]*\\n?/gi,
    /I will propose an action[^\\n]*\\n?/gi,
    /Now,?\\s*I will execute the[^\\n]*\\n?/gi,
    /Please wait for the results\\.?\\.?\\n?/gi,
    /This proposal expands the[^\\n]*\\n?/gi,
    /This proposal uses the[^\\n]*\\n?/gi,
    /Please let me know which proposal you would like to execute\\.?\\n?/gi,
    /Proposal:\\s*\x60\x60\x60/gi,
  ];
  for (let i = 0; i < narrations.length; i++) {
    clean = clean.replace(narrations[i], "");
  }

  // 4. Strip stray empty code fences
  clean = clean.replace(/\x60\x60\x60(?:json)?\\s*\x60\x60\x60/g, "").trim();
  if (!clean) return "";

  // 5. Extract code blocks into placeholders to protect code from other formatting
  const codeBlocks = [];
  clean = clean.replace(/\x60\x60\x60([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\x60\x60\x60/g, function(match, lang, code) {
    const idx = codeBlocks.length;
    const l = lang ? lang.trim() : "code";
    const escaped = escapeHtml(code.trim());
    codeBlocks.push(
      '<div class="code-block-container">' +
        '<div class="code-block-header">' +
          '<span>' + escapeHtml(l) + '</span>' +
          '<button class="code-copy-btn" onclick="copyCodeBlock(this)">Copy</button>' +
        '</div>' +
        '<pre style="margin:0; padding:0.85rem 1rem; overflow-x:auto; background:transparent; font-family:var(--font-mono); font-size:0.82rem; color:#e2e8f0;"><code>' + escaped + '</code></pre>' +
      '</div>'
    );
    return '__CODE_BLOCK_' + idx + '__';
  });

  // Escape HTML of prose
  let html = escapeHtml(clean);

  // Reinsert protected code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace('__CODE_BLOCK_' + i + '__', codeBlocks[i]);
  }

  // Headings
  html = html.replace(/^### (.*$)/gim, '<h4 style="font-size:0.95rem; font-weight:700; color:#f8fafc; margin:0.8rem 0 0.4rem;">$1</h4>');
  html = html.replace(/^## (.*$)/gim, '<h3 style="font-size:1.05rem; font-weight:700; color:#f8fafc; margin:0.9rem 0 0.45rem;">$1</h3>');
  html = html.replace(/^# (.*$)/gim, '<h2 style="font-size:1.15rem; font-weight:800; color:#fff; margin:1rem 0 0.5rem;">$1</h2>');

  // Inline formatting
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
  html = html.replace(/\\*([^*]+)\\*/g, '<i>$1</i>');
  html = html.replace(/\x60([^\x60]+)\x60/g, '<code style="font-family:var(--font-mono); background:#111928; padding:0.15rem 0.4rem; border-radius:4px; font-size:0.84rem; color:#93c5fd;">$1</code>');

  // Bullet points
  html = html.replace(/^\\s*[-*]\\s+(.*$)/gim, '<li style="margin-bottom:0.25rem;">$1</li>');
  html = html.replace(/(<li style="margin-bottom:0.25rem;">.*<\\/li>\\s*)+/g, '<ul style="padding-left:1.3rem; margin:0.5rem 0;">$&</ul>');

  // Paragraphs
  const paras = html.split(/\\n\\n+/);
  return paras.map(function(p) {
    if (p.indexOf('<div class="code-block-container">') >= 0 || p.indexOf('<h') === 0 || p.indexOf('<ul') === 0 || p.indexOf('<ol') === 0) {
      return p;
    }
    return '<p style="margin-bottom:0.6rem;">' + p.replace(/\\n/g, '<br>') + '</p>';
  }).join("");
}

function formatTime(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return "";
  }
}

async function decideEscalation(missionId, requestId, decision) {
  try {
    await api("POST", \`/missions/\${missionId}/escalations/\${requestId}\`, { decision });
    await loadMissionDetails(missionId);
  } catch (err) {
    alert("Failed to decide escalation: " + err.message);
  }
}

function switchTab(name, btn) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const target = document.getElementById("pane-" + name);
  if (target) target.classList.add("active");

  if (name === "gitdiff") loadGitDiffTab();
  if (name === "architecture") loadArchifyReport();
  if (name === "evidence" && currentMissionId) loadEvidenceTab(currentMissionId);
  if (name === "receipt" && currentMissionId) loadReceiptTab(currentMissionId);
}

async function loadGitDiffTab() {
  const box = document.getElementById("gitDiffContentBox");
  box.textContent = "Loading git diff...";
  try {
    const data = await api("GET", "/git/diff");
    box.textContent = data.diff || "No changes in working tree.";
  } catch (e) {
    box.textContent = "Failed to load git diff: " + e.message;
  }
}

async function loadEvidenceTab(missionId) {
  const box = document.getElementById("evidenceContentBox");
  box.innerHTML = '<div style="color:var(--text-muted);">Fetching evidence graph...</div>';
  try {
    const data = await api("GET", \`/missions/\${missionId}/evidence\`);
    box.innerHTML = \`
      <div class="tool-card tool-verify" style="background:#090d18; border:1px solid #1a2744; border-radius:8px; padding:1rem;">
        <div style="font-weight:700; color:#34d399; margin-bottom:0.5rem;">Verdicts & Criteria (\${data.verdicts.length})</div>
        <div style="font-family:var(--font-mono); font-size:0.75rem; color:#cbd5e1;"><pre>\${escapeHtml(JSON.stringify(data.verdicts, null, 2))}</pre></div>
      </div>
      <div class="tool-card tool-search" style="background:#090d18; border:1px solid #1a2744; border-radius:8px; padding:1rem;">
        <div style="font-weight:700; color:#38bdf8; margin-bottom:0.5rem;">Observations (\${data.observations.length})</div>
        <div style="font-family:var(--font-mono); font-size:0.75rem; color:#cbd5e1;"><pre>\${escapeHtml(JSON.stringify(data.observations, null, 2))}</pre></div>
      </div>
    \`;
  } catch (e) {
    box.innerHTML = \`<div style="color:#ef4444;">Failed to load evidence: \${escapeHtml(String(e.message))}</div>\`;
  }
}

async function loadReceiptTab(missionId) {
  const box = document.getElementById("receiptContentBox");
  box.innerHTML = '<div style="color:var(--text-muted);">Fetching closure receipt...</div>';
  try {
    const receipt = await api("GET", \`/missions/\${missionId}/receipt\`);
    box.innerHTML = \`
      <div style="background:#090d18; border:1px solid #1a2744; border-radius:10px; padding:1.25rem;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
          <div>
            <h3 style="color:#34d399; font-size:1.1rem; font-weight:700;">CRYPTOGRAPHIC CLOSURE RECEIPT</h3>
            <span style="font-size:0.75rem; color:#94a3b8; font-family:var(--font-mono);">\${escapeHtml(missionId)}</span>
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button class="btn-icon-soft" onclick="verifyReceiptChain(this.getAttribute('data-mid'))" data-mid="\${escapeHtml(missionId)}" title="Cryptographically verify SHA-256 chain of records">
              <span>🛡️ Verify Hash Chain</span>
            </button>
            <button class="btn-icon-soft" onclick="exportReceiptJson(this.getAttribute('data-mid'))" data-mid="\${escapeHtml(missionId)}" title="Download receipt as raw JSON file">
              <span>💾 Download JSON</span>
            </button>
            <button class="btn-icon-soft" onclick="exportReceiptMarkdown('\${missionId}')" title="Export receipt as formatted Markdown report">
              <span>📄 Export Markdown</span>
            </button>
          </div>
        </div>
        <div id="receiptVerifyResultNotice"></div>
        <div style="font-family:var(--font-mono); font-size:0.78rem; background:#04060d; padding:1rem; border-radius:8px; max-height:450px; overflow-y:auto; margin-top:0.75rem;"><pre>\${escapeHtml(JSON.stringify(receipt, null, 2))}</pre></div>
      </div>
    \`;
  } catch {
    box.innerHTML = '<div style="color:var(--text-muted);">Receipt is generated automatically when mission reaches closure.</div>';
  }
}

async function verifyReceiptChain(missionId) {
  const notice = document.getElementById("receiptVerifyResultNotice");
  notice.innerHTML = '<span style="color:#60a5fa;">Verifying SHA-256 hash chain...</span>';
  try {
    const res = await api("POST", \`/missions/\${missionId}/receipt/verify\`);
    if (res.verified) {
      notice.innerHTML = \`<div style="color:#34d399; font-weight:700; padding:8px 12px; background:rgba(16,185,129,0.15); border-radius:6px; margin-top:0.5rem;">✔ SHA-256 Hash Chain Verified: \${res.recordsVerified} records cryptographically validated. Chain Tip: <span style="font-family:var(--font-mono); font-size:0.75rem;">\${escapeHtml(res.chainTip ? res.chainTip.slice(0, 16) + '...' : '')}</span></div>\`;
    } else {
      notice.innerHTML = \`<div style="color:#ef4444; font-weight:700; margin-top:0.5rem;">Verification failed: \${escapeHtml(String(res.error ?? "unknown"))}</div>\`;
    }
  } catch (e) {
    notice.innerHTML = \`<div style="color:#ef4444; margin-top:0.5rem;">Verification error: \${escapeHtml(String(e.message))}</div>\`;
  }
}

async function exportReceiptJson(missionId) {
  try {
    const receipt = await api("GET", \`/missions/\${missionId}/receipt\`);
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`forge-receipt-\${missionId}.json\`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Failed to export receipt: " + e.message);
  }
}

async function exportReceiptMarkdown(missionId) {
  try {
    const receipt = await api("GET", \`/missions/\${missionId}/receipt\`);
    const r = receipt || {};
    const md = [
      \`# FORGE Cryptographic Closure Receipt\`,
      \`\`,
      \`- **Mission ID:** \\\`\${missionId}\\\`\`,
      \`- **Closure Verdict:** **\${(r.closure || 'UNKNOWN').toUpperCase()}**\`,
      \`- **Explanation:** \${r.explanation || 'N/A'}\`,
      \`- **Duration:** \${r.durationMs || 0}ms\`,
      \`- **Generated At:** \${new Date().toISOString()}\`,
      \`\`,
      \`## Invariant & Criterion Summary\`,
      \`- **Mechanical Criteria Passed:** \${r.criteriaPassed ? 'Yes' : 'No'}\`,
      \`- **Total Claims:** \${Array.isArray(r.claims) ? r.claims.length : 0}\`,
      \`\`,
      \`## Receipt Metadata\`,
      \`\\\`\\\`\\\`json\`,
      JSON.stringify(receipt, null, 2),
      \`\\\`\\\`\\\`\`
    ].join("\\n");

    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`forge-receipt-\${missionId}.md\`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Failed to export markdown: " + e.message);
  }
}

// Archify Loader
async function loadArchifyReport() {
  const pre = document.getElementById("archifyMermaidPre");
  const statsRow = document.getElementById("archifyStatsRow");
  const subsWrap = document.getElementById("archifySubsystemsWrap");

  pre.textContent = "Scanning workspace with Archify engine...";
  statsRow.innerHTML = "";
  subsWrap.innerHTML = "";

  try {
    const { report } = await api("GET", "/archify");
    statsRow.innerHTML = \`
      <div class="stat-card">
        <div class="stat-card-label">Repository</div>
        <div class="stat-card-val">\${escapeHtml(report.projectName)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Stack Type</div>
        <div class="stat-card-val" style="font-size:1.05rem;">\${escapeHtml(report.projectType)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Total Files</div>
        <div class="stat-card-val">\${report.totalFiles}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Lines of Code</div>
        <div class="stat-card-val">\${report.totalLines.toLocaleString()}</div>
      </div>
    \`;

    pre.textContent = report.mermaidDiagram;

    subsWrap.innerHTML = report.subsystems.map(s => \`
      <div style="background:#090d18; border:1px solid #18233c; border-radius:10px; padding:1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h4 style="color:#60a5fa; font-size:0.92rem; font-weight:700;">\${escapeHtml(s.name)}</h4>
          <span style="font-size:0.75rem; color:#8896ab;">\${s.files.length} modules</span>
        </div>
        <p style="font-size:0.78rem; color:#cbd5e1; margin-top:0.3rem;">\${escapeHtml(s.description)}</p>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.6rem;">
          \${s.files.map(f => \`<span style="font-family:var(--font-mono); font-size:0.7rem; background:#121a2d; color:#93c5fd; padding:0.15rem 0.45rem; border-radius:4px;">\${escapeHtml(f)}</span>\`).join("")}
        </div>
      </div>
    \`).join("");

  } catch (err) {
    pre.textContent = "Failed to load architecture report: " + err.message;
  }
}

// Global Refreshers
async function refreshAll() {
  await Promise.all([refreshMissions(), refreshProviders(), refreshWorkspaceAndGit()]);
}

async function refreshMissions() {
  try {
    const data = await api("GET", "/missions");
    allMissions = data.missions || [];
    document.getElementById("missionsCountBadge").textContent = allMissions.length;

    const listEl = document.getElementById("sidebarMissionsList");
    listEl.innerHTML = "";

    for (const m of allMissions) {
      const item = document.createElement("div");
      item.className = "nav-item" + (m.missionId === currentMissionId ? " active" : "");
      item.dataset.id = m.missionId;
      item.onclick = () => selectMission(m.missionId);

      let dot = "dot-running";
      if (m.status === "closed") {
        dot = m.closure === "verified" ? "dot-verified" : (m.closure === "blocked" ? "dot-blocked" : "dot-failed");
      }

      item.innerHTML = \`
        <span class="status-dot \${dot}"></span>
        <span class="nav-item-title">\${escapeHtml(m.goal || m.missionId)}</span>
        <button class="btn-delete-mission" title="Delete conversation" onclick="deleteMission(event, '\${m.missionId}')">✕</button>
      \`;
      listEl.appendChild(item);
    }
  } catch (e) {
    console.error("Failed to refresh missions", e);
  }
}

async function refreshProviders() {
  try {
    const data = await api("GET", "/providers");
    allProviders = data.providers || [];
    currentConfig = data;
    const activeProv = allProviders.find(p => p.id === data.activeProviderId);
    const activeModelName = data.activeModelId || (activeProv ? activeProv.model : "None");
    const provName = activeProv ? activeProv.name : "Provider";
    document.getElementById("topBarModelDisplay").textContent = \`\${provName} · \${activeModelName}\`;
  } catch (e) {
    console.error("Failed to refresh providers", e);
  }
}

async function refreshWorkspaceAndGit() {
  try {
    const ws = await api("GET", "/workspaces/current");
    if (ws.workspace) {
      document.getElementById("topBarWorkspaceDisplay").textContent = \`Workspace: \${ws.workspace.name}\`;
    }
    const git = await api("GET", "/git/status");
    if (git.status) {
      document.getElementById("topBarGitBranch").textContent = \`Git: \${git.status.branch}\`;
      const cleanDot = document.getElementById("gitCleanIndicator");
      cleanDot.className = "status-dot " + (git.status.clean ? "dot-verified" : "dot-blocked");
    }
  } catch (e) {
    console.error("Failed to refresh git/workspace", e);
  }
}

// Marketplace Logic
async function openMarketplaceModal() {
  document.getElementById("standardModalWindow").style.display = "none";
  document.getElementById("marketplaceModalWindow").style.display = "flex";
  document.getElementById("modalOverlay").classList.add("open");
  await refreshMarketplace();
}

async function refreshMarketplace() {
  try {
    const data = await api("GET", "/marketplace/plugins");
    allPlugins = data.plugins || [];
    renderInstalledCarousel(data.installed || []);
    renderMarketplaceCards(allPlugins);
  } catch (err) {
    console.error("Failed to fetch marketplace plugins:", err);
  }
}

function scrollCarousel(amt) {
  const track = document.getElementById("installedTrack");
  track.scrollBy({ left: amt, behavior: "smooth" });
}

function renderInstalledCarousel(installedList) {
  const track = document.getElementById("installedTrack");
  track.innerHTML = "";
  if (!installedList || installedList.length === 0) {
    track.innerHTML = '<span style="font-size:0.75rem; color:#64748b;">No plugins installed yet.</span>';
    return;
  }
  for (const p of installedList) {
    const pill = document.createElement("div");
    pill.className = "installed-icon-pill";
    pill.style.background = p.iconBg || "#1e293b";
    pill.title = p.name + " (" + (p.version || "1.0") + ")";
    pill.textContent = p.icon || "🧩";
    track.appendChild(pill);
  }
}

function filterPublicPersonal(tab) {
  currentMarketplaceTab = tab;
  document.getElementById("tabPublicBtn").classList.toggle("active", tab === "public");
  document.getElementById("tabPersonalBtn").classList.toggle("active", tab === "personal");
  filterPlugins(document.getElementById("marketplaceSearchInput").value);
}

function filterPlugins(query) {
  const q = (query || "").toLowerCase();
  let filtered = allPlugins;
  if (currentMarketplaceTab === "installed") {
    filtered = filtered.filter(p => p.installed);
  }
  if (q) {
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  }
  renderMarketplaceCards(filtered);
}

function renderMarketplaceCards(plugins) {
  const container = document.getElementById("marketplaceCatalogScroll");
  container.innerHTML = "";

  const groups = [
    { key: "developer-tools", label: "Developer Tools" },
    { key: "productivity", label: "Productivity" },
    { key: "finance", label: "Finance" },
    { key: "utilities", label: "Utilities" },
    { key: "other", label: "Other" },
  ];

  for (const g of groups) {
    const items = plugins.filter(p => p.category === g.key);
    if (items.length === 0) continue;

    const groupSection = document.createElement("div");
    groupSection.innerHTML = \`
      <div class="marketplace-group-title">\${g.label}</div>
      <div class="marketplace-cards-grid" id="grid-\${g.key}"></div>
    \`;
    container.appendChild(groupSection);

    const grid = groupSection.querySelector(\`#grid-\${g.key}\`);
    for (const p of items) {
      const card = document.createElement("div");
      card.className = "plugin-card";
      const isInstalled = Boolean(p.installed);
      const actionHtml = isInstalled
        ? \`<button class="btn-plugin-installed" title="Installed (Click to toggle)" onclick="togglePlugin('\${p.id}')">···</button>\`
        : \`<button class="btn-plugin-install" onclick="togglePlugin('\${p.id}')">Install</button>\`;

      const badgeHtml = p.badge ? \`<span class="badge-coding-plan">👑 \${p.badge}</span>\` : "";

      card.innerHTML = \`
        <div class="plugin-card-icon" style="background:\${p.iconBg || "#1e293b"};">
          \${p.icon || "🧩"}
        </div>
        <div class="plugin-card-info">
          <div class="plugin-title-row">
            <span class="plugin-name">\${escapeHtml(p.name)}</span>
            \${badgeHtml}
          </div>
          <p class="plugin-desc">\${escapeHtml(p.description)}</p>
        </div>
        <div class="plugin-card-action">
          \${actionHtml}
        </div>
      \`;
      grid.appendChild(card);
    }
  }
}

async function togglePlugin(id) {
  try {
    await api("POST", \`/marketplace/plugins/\${id}/toggle\`);
    await refreshMarketplace();
  } catch (err) {
    alert("Error updating plugin: " + err.message);
  }
}

// Memory Modal Logic
async function openMemoryModal() {
  document.getElementById("marketplaceModalWindow").style.display = "none";
  document.getElementById("standardModalWindow").style.display = "flex";
  document.getElementById("modalTitle").textContent = "Continuous Memory & Learned Lessons";
  document.getElementById("modalOverlay").classList.add("open");

  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Loading memory items...</span>';

  try {
    const { memories } = await api("GET", "/memory");
    body.innerHTML = \`
      <div style="background:#060913; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.6rem;">
        <h4 style="font-size:0.85rem; color:#fff; font-weight:700;">Add Knowledge / Platform Rule</h4>
        <input id="newMemTitle" placeholder="Title (e.g. Code Style, Test Policy)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
        <textarea id="newMemContent" placeholder="Describe rule or preference to persist into reasoning prompt..." rows="2" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none; resize:none;"></textarea>
        <button class="btn-icon-soft" style="align-self:flex-end; background:#2563eb; color:#fff; border:none;" onclick="saveNewMemory()">Save Rule</button>
      </div>
      <div id="memoryCardsList" style="display:flex; flex-direction:column; gap:0.65rem; margin-top:0.5rem;">
        \${memories.map(m => \`
          <div class="memory-card">
            <div class="memory-top-row">
              <span class="memory-badge">\${m.category.toUpperCase()}</span>
              <span style="font-size:0.75rem; font-weight:700; color:#fff; flex:1; margin-left:0.5rem;">\${escapeHtml(m.title)}</span>
              <button class="btn-delete-mission" style="opacity:1;" title="Delete" onclick="deleteMemoryItem('\${m.id}')">✕</button>
            </div>
            <p style="font-size:0.78rem; color:#cbd5e1; line-height:1.45;">\${escapeHtml(m.content)}</p>
            <div style="display:flex; justify-content:space-between; font-size:0.7rem; color:#64748b; margin-top:0.2rem;">
              <span>Source: \${m.source}</span>
              <span>Confidence: \${Math.round((m.confidence || 0.9) * 100)}%</span>
            </div>
          </div>
        \`).join("")}
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load memory: ' + err.message + '</span>';
  }
}

async function saveNewMemory() {
  const title = document.getElementById("newMemTitle").value.trim();
  const content = document.getElementById("newMemContent").value.trim();
  if (!title || !content) return;
  try {
    await api("POST", "/memory", { title, content, category: "rule" });
    await openMemoryModal();
  } catch (err) {
    alert("Error saving memory: " + err.message);
  }
}

async function deleteMemoryItem(id) {
  try {
    await api("DELETE", \`/memory/\${id}\`);
    await openMemoryModal();
  } catch (err) {
    alert("Error deleting memory: " + err.message);
  }
}

function openModal(type) {
  document.getElementById("marketplaceModalWindow").style.display = "none";
  const standardModal = document.getElementById("standardModalWindow");
  standardModal.style.display = "flex";
  standardModal.style.maxWidth = "640px";
  document.getElementById("modalOverlay").classList.add("open");

  if (type === "skillsModal") {
    document.getElementById("modalTitle").textContent = "Governed Capabilities";
    document.getElementById("modalBody").innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:0.75rem;">
        <div class="stat-card"><b>File System (fs)</b><br><span style="font-size:0.78rem; color:#94a3b8;">Write, patch, append, mkdir within allowed workspace tree.</span></div>
        <div class="stat-card"><b>Process Exec (shell)</b><br><span style="font-size:0.78rem; color:#94a3b8;">Argv-bounded execution with zero shell interpolation.</span></div>
        <div class="stat-card"><b>Workspace Search (search)</b><br><span style="font-size:0.78rem; color:#94a3b8;">Fast glob & regex search over workspace repository.</span></div>
        <div class="stat-card"><b>Git VCS (git)</b><br><span style="font-size:0.78rem; color:#94a3b8;">Status, diff, commit, branch within isolated worktree.</span></div>
        <div class="stat-card"><b>HTTP Client (http)</b><br><span style="font-size:0.78rem; color:#94a3b8;">SSRF-safe external resource fetching.</span></div>
        <div class="stat-card"><b>Criterion Verifier (verify)</b><br><span style="font-size:0.78rem; color:#94a3b8;">Mechanical assertions & automated test validation.</span></div>
      </div>
    \`;
  } else if (type === "providersModal") {
    renderProvidersModal();
  } else if (type === "modelsModal") {
    renderModelsModal();
  } else if (type === "credentialsModal") {
    renderCredentialsModal();
  } else if (type === "workspacesModal") {
    renderWorkspacesModal();
  } else if (type === "gitModal") {
    renderGitModal();
  } else if (type === "recoveryModal") {
    renderRecoveryModal();
  }
}

// 1. Providers Modal
async function renderProvidersModal() {
  const modal = document.getElementById("standardModalWindow");
  modal.style.maxWidth = "780px";
  document.getElementById("modalTitle").textContent = "Model Providers & Endpoints";
  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Loading providers...</span>';

  try {
    const data = await api("GET", "/providers");
    const providers = data.providers || [];
    const activeId = data.activeProviderId;

    body.innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:1.2rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; background:#070b16; border:1px solid #162035; padding:0.85rem 1rem; border-radius:8px;">
          <div>
            <span style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; font-weight:700;">Active Provider</span>
            <div style="font-size:1rem; font-weight:700; color:#fff; margin-top:0.2rem;">
              \${escapeHtml(providers.find(p => p.id === activeId)?.name || activeId || "None")}
            </div>
          </div>
          <span class="status-badge-lg badge-verified">ACTIVE</span>
        </div>

        <div>
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700; margin-bottom:0.6rem;">Configured Providers (\${providers.length})</h4>
          <div style="display:flex; flex-direction:column; gap:0.65rem;">
            \${providers.map(p => \`
              <div style="background:#090d19; border:1px solid \${p.id === activeId ? '#2563eb' : '#141c2e'}; border-radius:8px; padding:0.85rem 1rem; display:flex; flex-direction:column; gap:0.5rem;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="display:flex; align-items:center; gap:0.6rem;">
                    <b style="color:#fff; font-size:0.92rem;">\${escapeHtml(p.name)}</b>
                    <span style="font-size:0.68rem; padding:0.1rem 0.4rem; background:#141f38; color:#60a5fa; border-radius:4px; font-weight:600;">\${escapeHtml(p.kind)}</span>
                    \${p.id === activeId ? '<span style="font-size:0.68rem; padding:0.1rem 0.4rem; background:rgba(16,185,129,0.2); color:#34d399; border-radius:4px; font-weight:700;">DEFAULT</span>' : ''}
                  </div>
                  <div style="display:flex; gap:0.4rem;">
                    <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="testProviderConnection('\${p.id}')">⚡ Test</button>
                    <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="refreshProviderModels('\${p.id}')">🔄 Models</button>
                    \${p.id !== activeId ? \`<button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="setDefaultProvider('\${p.id}')">★ Set Default</button>\` : ''}
                    <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.5rem; color:#ef4444;" onclick="deleteProvider('\${p.id}')">✕</button>
                  </div>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#64748b; font-family:var(--font-mono);">
                  <span>Base URL: <span style="color:#94a3b8;">\${escapeHtml(p.baseUrl)}</span></span>
                  <span>Key Env: <span style="color:#94a3b8;">\${escapeHtml(p.apiKeyEnvVar)}</span></span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:#94a3b8; border-top:1px solid #131b2e; padding-top:0.4rem; margin-top:0.2rem;">
                  <span>Models: <b style="color:#e2e8f0;">\${p.availableModels ? p.availableModels.length : 0}</b> registered</span>
                  <span id="provStatus_\${p.id}" style="color:\${p.status === 'healthy' ? '#34d399' : (p.status === 'error' ? '#ef4444' : '#94a3b8')};">
                    \${p.status ? p.status.toUpperCase() : 'UNTESTED'} \${p.latencyMs ? \`(\${p.latencyMs}ms)\` : ''}
                  </span>
                </div>
              </div>
            \`).join("")}
          </div>
        </div>

        <!-- Add New Provider Form -->
        <div style="background:#060913; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.6rem;">
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700;">Register New Provider</h4>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
            <input id="newProvId" placeholder="Provider ID (e.g. deepseek, ollama)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
            <input id="newProvName" placeholder="Display Name (e.g. DeepSeek API)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
            <select id="newProvKind" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;">
              <option value="openai-compatible">OpenAI-Compatible</option>
              <option value="anthropic-messages">Anthropic Messages</option>
              <option value="nvidia-nim">NVIDIA NIM</option>
            </select>
            <input id="newProvKeyEnv" placeholder="API Key Env Var (e.g. DEEPSEEK_API_KEY)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          </div>
          <input id="newProvUrl" placeholder="Base URL (e.g. https://api.deepseek.com/v1)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          <input id="newProvModel" placeholder="Default Model (e.g. deepseek-chat)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          <button class="btn-icon-soft" style="align-self:flex-end; background:#2563eb; color:#fff; border:none; padding:0.4rem 0.9rem;" onclick="saveNewProvider()">Save & Register Provider</button>
        </div>
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load providers: ' + err.message + '</span>';
  }
}

async function testProviderConnection(id) {
  const el = document.getElementById("provStatus_" + id);
  if (el) el.textContent = "Testing...";
  try {
    const res = await api("POST", \`/providers/\${id}/test\`);
    if (res.ok) {
      alert(\`✓ Connection successful! Latency: \${res.latencyMs}ms, Models found: \${res.modelsFound ? res.modelsFound.length : 0}\`);
    } else {
      alert(\`✗ Connection failed: \${res.error}\`);
    }
    await renderProvidersModal();
  } catch (err) {
    alert("Test connection error: " + err.message);
  }
}

async function refreshProviderModels(id) {
  try {
    const res = await api("POST", \`/providers/\${id}/refresh-models\`);
    alert(\`Refreshed! Found \${res.models ? res.models.length : 0} models.\`);
    await renderProvidersModal();
    await refreshProviders();
  } catch (err) {
    alert("Failed to refresh models: " + err.message);
  }
}

async function setDefaultProvider(id) {
  try {
    await api("POST", "/providers/default", { providerId: id });
    await renderProvidersModal();
    await refreshProviders();
  } catch (err) {
    alert("Failed to set default provider: " + err.message);
  }
}

async function deleteProvider(id) {
  if (!confirm("Are you sure you want to delete provider '" + id + "'?")) return;
  try {
    await api("DELETE", \`/providers/\${id}\`);
    await renderProvidersModal();
    await refreshProviders();
  } catch (err) {
    alert("Failed to delete provider: " + err.message);
  }
}

async function saveNewProvider() {
  const id = document.getElementById("newProvId").value.trim();
  const name = document.getElementById("newProvName").value.trim();
  const kind = document.getElementById("newProvKind").value;
  const baseUrl = document.getElementById("newProvUrl").value.trim();
  const apiKeyEnvVar = document.getElementById("newProvKeyEnv").value.trim();
  const model = document.getElementById("newProvModel").value.trim();

  if (!id || !name || !baseUrl) {
    alert("Provider ID, Name, and Base URL are required.");
    return;
  }

  try {
    await api("POST", "/providers", {
      id, name, kind, baseUrl, apiKeyEnvVar, model,
      enabled: true, isDefault: false, availableModels: model ? [model] : []
    });
    await renderProvidersModal();
    await refreshProviders();
  } catch (err) {
    alert("Failed to save provider: " + err.message);
  }
}

// 2. Models & Routing Modal
async function renderModelsModal() {
  const modal = document.getElementById("standardModalWindow");
  modal.style.maxWidth = "780px";
  document.getElementById("modalTitle").textContent = "Model Routing & Hyperparameters";
  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Loading models & routing...</span>';

  try {
    const data = await api("GET", "/models");
    const models = data.models || [];
    const activeProv = data.activeProviderId;
    const activeModel = data.activeModelId;
    const activeFallback = data.activeFallbackModelId;
    const routingStrategy = data.routingStrategy || "fallback";

    body.innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:1.2rem;">
        <div style="background:#070b16; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.8rem;">
          <h4 style="font-size:0.88rem; color:#fff; font-weight:700;">Model Routing Configuration</h4>
          
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
            <div>
              <label style="font-size:0.75rem; color:#94a3b8; font-weight:600; display:block; margin-bottom:0.3rem;">Primary Model</label>
              <select id="routePrimaryModel" style="width:100%; background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;">
                \${models.map(m => \`<option value="\${m.providerId}:::\${m.id}" \${(m.id === activeModel && m.providerId === activeProv) ? 'selected' : ''}>[\${escapeHtml(m.providerName)}] \${escapeHtml(m.displayName || m.id)}</option>\`).join("")}
              </select>
            </div>

            <div>
              <label style="font-size:0.75rem; color:#94a3b8; font-weight:600; display:block; margin-bottom:0.3rem;">Fallback Model (Auto-Failover)</label>
              <select id="routeFallbackModel" style="width:100%; background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;">
                <option value="">None (Fail immediately on error)</option>
                \${models.map(m => \`<option value="\${m.id}" \${m.id === activeFallback ? 'selected' : ''}>[\${escapeHtml(m.providerName)}] \${escapeHtml(m.displayName || m.id)}</option>\`).join("")}
              </select>
            </div>
          </div>

          <div>
            <label style="font-size:0.75rem; color:#94a3b8; font-weight:600; display:block; margin-bottom:0.3rem;">Routing Strategy</label>
            <select id="routeStrategy" style="width:100%; background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;">
              <option value="fallback" \${routingStrategy === 'fallback' ? 'selected' : ''}>Fallback (Failover to backup on rate-limit, 5xx, or network failure)</option>
              <option value="single" \${routingStrategy === 'single' ? 'selected' : ''}>Single (Strict execution on primary model only)</option>
              <option value="best-available" \${routingStrategy === 'best-available' ? 'selected' : ''}>Best-Available (Select lowest latency healthy provider)</option>
            </select>
          </div>

          <button class="btn-icon-soft" style="align-self:flex-end; background:#2563eb; color:#fff; border:none; padding:0.45rem 1rem;" onclick="saveModelRouting()">Apply Routing Configuration</button>
        </div>

        <div style="background:#070b16; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.8rem;">
          <h4 style="font-size:0.88rem; color:#fff; font-weight:700;">Model Hyperparameters Tuning</h4>

          <div>
            <label style="font-size:0.75rem; color:#94a3b8; font-weight:600; display:block; margin-bottom:0.3rem;">Select Model to Configure</label>
            <select id="tuneModelSelect" style="width:100%; background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;">
              \${models.map(m => \`<option value="\${m.id}" data-provider="\${m.providerId}">[\${escapeHtml(m.providerName)}] \${escapeHtml(m.displayName || m.id)}</option>\`).join("")}
            </select>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#94a3b8; margin-bottom:0.3rem;">
                <span>Temperature</span>
                <span id="tempValDisplay">0.2</span>
              </div>
              <input type="range" id="paramTemperature" min="0" max="1" step="0.05" value="0.2" style="width:100%; accent-color:#3b82f6;" oninput="document.getElementById('tempValDisplay').textContent = this.value" />
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#94a3b8; margin-bottom:0.3rem;">
                <span>Top P</span>
                <span id="topPValDisplay">0.95</span>
              </div>
              <input type="range" id="paramTopP" min="0" max="1" step="0.05" value="0.95" style="width:100%; accent-color:#3b82f6;" oninput="document.getElementById('topPValDisplay').textContent = this.value" />
            </div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
            <div>
              <label style="font-size:0.75rem; color:#94a3b8; font-weight:600; display:block; margin-bottom:0.3rem;">Max Output Tokens</label>
              <input type="number" id="paramMaxTokens" value="4096" style="width:100%; background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
            </div>
            <div>
              <label style="font-size:0.75rem; color:#94a3b8; font-weight:600; display:block; margin-bottom:0.3rem;">Reasoning Effort</label>
              <select id="paramReasoningEffort" style="width:100%; background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;">
                <option value="low">Low (Fast responses)</option>
                <option value="medium" selected>Medium (Standard)</option>
                <option value="high">High (Deep reasoning)</option>
              </select>
            </div>
          </div>

          <button class="btn-icon-soft" style="align-self:flex-end; background:#2563eb; color:#fff; border:none; padding:0.45rem 1rem;" onclick="saveModelParameters()">Update Parameters</button>
        </div>
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load models: ' + err.message + '</span>';
  }
}

async function saveModelRouting() {
  const pVal = document.getElementById("routePrimaryModel").value;
  const [providerId, modelId] = pVal.split(":::");
  const fallbackModelId = document.getElementById("routeFallbackModel").value || undefined;

  try {
    await api("POST", "/models/select", { providerId, modelId, fallbackModelId });
    alert("Routing configuration updated successfully!");
    await refreshProviders();
    await renderModelsModal();
  } catch (err) {
    alert("Failed to update routing: " + err.message);
  }
}

async function saveModelParameters() {
  const sel = document.getElementById("tuneModelSelect");
  const modelId = sel.value;
  const providerId = sel.selectedOptions[0]?.dataset?.provider;
  const temperature = parseFloat(document.getElementById("paramTemperature").value);
  const topP = parseFloat(document.getElementById("paramTopP").value);
  const maxTokens = parseInt(document.getElementById("paramMaxTokens").value, 10);
  const reasoningEffort = document.getElementById("paramReasoningEffort").value;

  try {
    await api("PUT", \`/models/\${modelId}\`, {
      providerId,
      parameters: { temperature, topP, maxTokens, reasoningEffort }
    });
    alert(\`Parameters for \${modelId} saved.\`);
  } catch (err) {
    alert("Failed to save parameters: " + err.message);
  }
}

// 3. Credentials Modal
async function renderCredentialsModal() {
  const modal = document.getElementById("standardModalWindow");
  modal.style.maxWidth = "780px";
  document.getElementById("modalTitle").textContent = "API Credentials & Secrets Manager";
  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Loading credentials...</span>';

  try {
    const data = await api("GET", "/credentials");
    const creds = data.credentials || [];

    body.innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:1.2rem;">
        <p style="font-size:0.82rem; color:#94a3b8;">
          API keys are isolated and never transmitted to language models. Only environment variable bindings are injected into strictly governed host capability containers.
        </p>

        <div>
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700; margin-bottom:0.6rem;">Managed Credentials (\${creds.length})</h4>
          <div style="display:flex; flex-direction:column; gap:0.6rem;">
            \${creds.map(c => \`
              <div style="background:#090d19; border:1px solid #141c2e; border-radius:8px; padding:0.85rem 1rem; display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div style="display:flex; align-items:center; gap:0.5rem;">
                    <b style="color:#fff; font-size:0.9rem;">\${escapeHtml(c.name)}</b>
                    <span style="font-family:var(--font-mono); font-size:0.75rem; color:#38bdf8; background:#0e172a; padding:0.1rem 0.4rem; border-radius:4px;">\${escapeHtml(c.envVar)}</span>
                  </div>
                  <div style="font-size:0.74rem; color:#64748b; font-family:var(--font-mono); margin-top:0.25rem;">
                    Masked: <span style="color:#cbd5e1;">\${escapeHtml(c.maskedValue)}</span>
                    \${c.lastRotatedAt ? \`<span style="margin-left:0.6rem;">Rotated: \${formatTime(c.lastRotatedAt)}</span>\` : ''}
                  </div>
                </div>
                <div style="display:flex; gap:0.4rem;">
                  <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="testCredential('\${c.id}')">🔍 Test</button>
                  <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="promptRotateCredential('\${c.id}', '\${escapeHtml(c.name)}')">🔄 Rotate</button>
                  <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.5rem; color:#ef4444;" onclick="deleteCredential('\${c.id}')">✕</button>
                </div>
              </div>
            \`).join("")}
            \${creds.length === 0 ? '<div style="color:#64748b; font-size:0.82rem; padding:1rem; text-align:center;">No credentials registered.</div>' : ''}
          </div>
        </div>

        <div style="background:#060913; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.6rem;">
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700;">Add Credential</h4>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
            <input id="newCredName" placeholder="Friendly Name (e.g. OpenAI Key)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
            <input id="newCredEnvVar" placeholder="Env Variable (e.g. OPENAI_API_KEY)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          </div>
          <input id="newCredValue" type="password" placeholder="Secret Key Value (e.g. sk-... or nvapi-...)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          <button class="btn-icon-soft" style="align-self:flex-end; background:#2563eb; color:#fff; border:none; padding:0.4rem 0.9rem;" onclick="saveNewCredential()">Save Credential</button>
        </div>
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load credentials: ' + err.message + '</span>';
  }
}

async function testCredential(id) {
  try {
    const res = await api("POST", \`/credentials/\${id}/test\`);
    alert(res.ok ? \`✓ Env variable '\${res.envVar}' is set in process.\` : \`✗ Env variable '\${res.envVar}' is NOT set.\`);
  } catch (err) {
    alert("Test credential error: " + err.message);
  }
}

async function promptRotateCredential(id, name) {
  const newVal = prompt("Enter new secret key value for " + name + ":");
  if (!newVal) return;
  try {
    await api("POST", \`/credentials/\${id}/rotate\`, { value: newVal });
    alert("Credential rotated successfully.");
    await renderCredentialsModal();
  } catch (err) {
    alert("Failed to rotate credential: " + err.message);
  }
}

async function deleteCredential(id) {
  if (!confirm("Are you sure you want to delete this credential?")) return;
  try {
    await api("DELETE", \`/credentials/\${id}\`);
    await renderCredentialsModal();
  } catch (err) {
    alert("Failed to delete credential: " + err.message);
  }
}

async function saveNewCredential() {
  const name = document.getElementById("newCredName").value.trim();
  const envVar = document.getElementById("newCredEnvVar").value.trim();
  const value = document.getElementById("newCredValue").value.trim();
  if (!name || !envVar || !value) {
    alert("Name, Env Var, and Secret Value are required.");
    return;
  }
  try {
    await api("POST", "/credentials", { name, envVar, value });
    await renderCredentialsModal();
  } catch (err) {
    alert("Failed to save credential: " + err.message);
  }
}

// 4. Workspaces Modal
async function renderWorkspacesModal() {
  const modal = document.getElementById("standardModalWindow");
  modal.style.maxWidth = "780px";
  document.getElementById("modalTitle").textContent = "Workspaces & Repositories";
  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Loading workspaces...</span>';

  try {
    const data = await api("GET", "/workspaces");
    const workspaces = data.workspaces || [];
    const currentId = data.currentWorkspaceId;

    body.innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:1.2rem;">
        <div>
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700; margin-bottom:0.6rem;">Registered Workspaces (\${workspaces.length})</h4>
          <div style="display:flex; flex-direction:column; gap:0.6rem;">
            \${workspaces.map(w => \`
              <div style="background:#090d19; border:1px solid \${w.id === currentId ? '#2563eb' : '#141c2e'}; border-radius:8px; padding:0.85rem 1rem; display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div style="display:flex; align-items:center; gap:0.6rem;">
                    <b style="color:#fff; font-size:0.9rem;">\${escapeHtml(w.name)}</b>
                    \${w.id === currentId ? '<span style="font-size:0.68rem; padding:0.1rem 0.4rem; background:rgba(16,185,129,0.2); color:#34d399; border-radius:4px; font-weight:700;">ACTIVE</span>' : ''}
                  </div>
                  <div style="font-size:0.75rem; color:#94a3b8; font-family:var(--font-mono); margin-top:0.25rem;">
                    <code>\${escapeHtml(w.path)}</code>
                  </div>
                </div>
                <div style="display:flex; gap:0.4rem;">
                  \${w.id !== currentId ? \`<button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="switchWorkspace('\${w.id}')">Switch</button>\` : ''}
                  \${w.id !== currentId ? \`<button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.5rem; color:#ef4444;" onclick="deleteWorkspace('\${w.id}')">✕</button>\` : ''}
                </div>
              </div>
            \`).join("")}
          </div>
        </div>

        <div style="background:#060913; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.6rem;">
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700;">Add Workspace</h4>
          <input id="newWsName" placeholder="Workspace Name (e.g. Payments Service)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          <input id="newWsPath" placeholder="Directory Path (e.g. D:/projects/payments)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.4rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          <button class="btn-icon-soft" style="align-self:flex-end; background:#2563eb; color:#fff; border:none; padding:0.4rem 0.9rem;" onclick="saveNewWorkspace()">Register Workspace</button>
        </div>
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load workspaces: ' + err.message + '</span>';
  }
}

async function switchWorkspace(id) {
  try {
    await api("POST", "/workspaces/switch", { workspaceId: id });
    await refreshWorkspaceAndGit();
    await renderWorkspacesModal();
  } catch (err) {
    alert("Failed to switch workspace: " + err.message);
  }
}

async function deleteWorkspace(id) {
  if (!confirm("Are you sure you want to delete workspace '" + id + "'?")) return;
  try {
    await api("DELETE", \`/workspaces/\${id}\`);
    await renderWorkspacesModal();
  } catch (err) {
    alert("Failed to delete workspace: " + err.message);
  }
}

async function saveNewWorkspace() {
  const name = document.getElementById("newWsName").value.trim();
  const path = document.getElementById("newWsPath").value.trim();
  if (!name || !path) {
    alert("Name and Path are required.");
    return;
  }
  try {
    await api("POST", "/workspaces", { name, path });
    await renderWorkspacesModal();
  } catch (err) {
    alert("Failed to register workspace: " + err.message);
  }
}

// 5. Git VCS Modal
async function renderGitModal() {
  const modal = document.getElementById("standardModalWindow");
  modal.style.maxWidth = "700px";
  document.getElementById("modalTitle").textContent = "Git Version Control";
  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Loading git status...</span>';

  try {
    const data = await api("GET", "/git/status");
    body.innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:1.2rem;">
        <div style="background:#070b16; border:1px solid #162035; border-radius:8px; padding:0.85rem 1rem; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <span style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; font-weight:700;">Branch & State</span>
            <div style="font-size:1rem; font-weight:700; color:#fff; margin-top:0.2rem;">
              \${escapeHtml(data.branch || "HEAD")}
            </div>
          </div>
          <span class="status-badge-lg \${data.clean ? 'badge-verified' : 'badge-running'}">
            \${data.clean ? 'CLEAN' : 'DIRTY (CHANGES PENDING)'}
          </span>
        </div>

        <div>
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700; margin-bottom:0.4rem;">Working Tree Status</h4>
          <div style="background:#050811; border:1px solid #141f38; border-radius:8px; padding:0.75rem; font-family:var(--font-mono); font-size:0.76rem; max-height:160px; overflow-y:auto;">
            \${(data.modified && data.modified.length > 0) ? \`<div style="color:#fbbf24; margin-bottom:0.3rem;"><b>Modified:</b><br>\${data.modified.map(f => '  M ' + escapeHtml(f)).join('<br>')}</div>\` : ''}
            \${(data.untracked && data.untracked.length > 0) ? \`<div style="color:#38bdf8;"><b>Untracked:</b><br>\${data.untracked.map(f => '  ? ' + escapeHtml(f)).join('<br>')}</div>\` : ''}
            \${(data.clean) ? '<span style="color:#34d399;">Working tree is clean. No uncommitted changes.</span>' : ''}
          </div>
        </div>

        <div style="background:#060913; border:1px solid #162035; border-radius:8px; padding:1rem; display:flex; flex-direction:column; gap:0.6rem;">
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700;">Create Commit</h4>
          <input id="gitCommitMsg" placeholder="Commit message (e.g. feat: implement provider fallback)" style="background:#0a0f1d; border:1px solid #1c2844; border-radius:6px; padding:0.45rem 0.6rem; color:#fff; font-size:0.82rem; outline:none;" />
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <button class="btn-icon-soft" onclick="closeModal(); switchTab('gitdiff');">View Full Diff</button>
            <button class="btn-icon-soft" style="background:#2563eb; color:#fff; border:none; padding:0.4rem 0.9rem;" onclick="submitGitCommit()">Commit Changes</button>
          </div>
        </div>
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load git status: ' + err.message + '</span>';
  }
}

async function submitGitCommit() {
  const message = document.getElementById("gitCommitMsg").value.trim();
  if (!message) {
    alert("Commit message is required.");
    return;
  }
  try {
    const res = await api("POST", "/git/commit", { message });
    if (res.ok) {
      alert(\`✓ Committed: \${res.commitHash}\`);
      await refreshWorkspaceAndGit();
      await renderGitModal();
    } else {
      alert(\`✗ Commit failed: \${res.error}\`);
    }
  } catch (err) {
    alert("Commit error: " + err.message);
  }
}

// 6. Recovery Center Modal
async function renderRecoveryModal() {
  const modal = document.getElementById("standardModalWindow");
  modal.style.maxWidth = "800px";
  document.getElementById("modalTitle").textContent = "Mission Recovery Center (ADR-0008)";
  const body = document.getElementById("modalBody");
  body.innerHTML = '<span style="color:#64748b;">Classifying missions for recovery...</span>';

  try {
    const data = await api("GET", "/recovery/missions");
    const missions = data.missions || [];

    body.innerHTML = \`
      <div style="display:flex; flex-direction:column; gap:1.2rem;">
        <p style="font-size:0.82rem; color:#94a3b8;">
          Inspect interrupted or failed missions, detect unobserved dispatches, and cleanly resume execution or abort without corrupting the cryptographic hash chain.
        </p>

        <div>
          <h4 style="font-size:0.85rem; color:#fff; font-weight:700; margin-bottom:0.6rem;">Mission Diagnostics (\${missions.length})</h4>
          <div style="display:flex; flex-direction:column; gap:0.65rem;">
            \${missions.map(m => {
              const isClosed = Boolean(m.closure) || m.status === 'verified' || m.status === 'failed' || m.status === 'blocked';
              const classColor = (m.status === 'verified') ? '#34d399' : (m.status === 'pending_escalation' ? '#fbbf24' : (m.resumable ? '#38bdf8' : '#ef4444'));
              return \`
                <div style="background:#090d19; border:1px solid #141c2e; border-radius:8px; padding:0.85rem 1rem; display:flex; flex-direction:column; gap:0.5rem;">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:0.6rem;">
                      <b style="color:#fff; font-size:0.88rem; font-family:var(--font-mono);">\${m.missionId}</b>
                      <span style="font-size:0.7rem; padding:0.12rem 0.45rem; border-radius:4px; font-weight:700; background:rgba(255,255,255,0.06); color:\${classColor};">
                        \${m.status.toUpperCase()}
                      </span>
                      \${m.closure ? \`<span class="status-badge-lg badge-verified" style="font-size:0.65rem; padding:0.1rem 0.4rem;">\${m.closure.toUpperCase()}</span>\` : ''}
                    </div>
                    <div style="display:flex; gap:0.4rem;">
                      \${m.resumable ? \`
                        <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem; background:rgba(37,99,235,0.2); color:#60a5fa;" onclick="resumeRecoveryMission('\${m.missionId}')">▶ Resume</button>
                      \` : ''}
                      \${!isClosed ? \`
                        <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.5rem; color:#ef4444;" onclick="abortRecoveryMission('\${m.missionId}')">✕ Abort</button>
                      \` : ''}
                      <button class="btn-icon-soft" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="closeModal(); selectMission('\${m.missionId}')">Inspect</button>
                    </div>
                  </div>
                  <div style="font-size:0.78rem; color:#cbd5e1;">\${escapeHtml(m.goal || "(No goal stated)")}</div>
                  <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:#64748b;">
                    <span>Records: \${m.recordCount} · Resumable: \${m.resumable ? 'Yes' : 'No'} · Post-Effect Unknown: \${m.effectsMayHaveOccurred ? 'Yes' : 'No'}</span>
                    <span>Reason: \${escapeHtml(m.reason)}</span>
                  </div>
                </div>
              \`;
            }).join("")}
            \${missions.length === 0 ? '<div style="color:#64748b; font-size:0.82rem; padding:1rem; text-align:center;">No missions found.</div>' : ''}
          </div>
        </div>
      </div>
    \`;
  } catch (err) {
    body.innerHTML = '<span style="color:#ef4444;">Failed to load recovery diagnostics: ' + err.message + '</span>';
  }
}

async function resumeRecoveryMission(id) {
  try {
    const res = await api("POST", \`/recovery/\${id}/resume\`);
    alert(\`Mission resumed. Outcome closure: \${res.closure || 'resumed'}\`);
    await renderRecoveryModal();
    await refreshMissions();
  } catch (err) {
    alert("Failed to resume mission: " + err.message);
  }
}

async function abortRecoveryMission(id) {
  if (!confirm("Are you sure you want to abort mission '" + id + "'?")) return;
  try {
    await api("POST", \`/recovery/\${id}/abort\`);
    alert("Mission aborted.");
    await renderRecoveryModal();
    await refreshMissions();
  } catch (err) {
    alert("Failed to abort mission: " + err.message);
  }
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Connect Real-Time SSE Stream
function connectSse() {
  const es = new EventSource("/events?token=" + TOKEN);

  es.addEventListener("model.delta", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (currentMissionId && data.missionId === currentMissionId) {
        if (data.text) {
          updateStreamingDelta(data.text);
        }
      }
    } catch {}
  });

  es.addEventListener("proposal.created", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (currentMissionId && data.missionId === currentMissionId) {
        handleToolProposal(data.body);
      }
    } catch {}
  });

  es.addEventListener("model.reply", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (currentMissionId && data.missionId === currentMissionId) {
        finalizeStreamingTurn(data.body?.text);
        loadMissionDialogue(currentMissionId);
      }
    } catch {}
  });

  es.addEventListener("mission.turn.completed", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (currentMissionId && data.missionId === currentMissionId) {
        finalizeStreamingTurn();
        loadMissionDialogue(currentMissionId);
        loadMissionDetails(currentMissionId);
      }
    } catch {}
  });

  es.addEventListener("mission.closed", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (currentMissionId && data.missionId === currentMissionId) {
        finalizeStreamingTurn();
        loadMissionDialogue(currentMissionId);
        loadMissionDetails(currentMissionId);
      }
      refreshMissions();
    } catch {}
  });

  es.addEventListener("mission.deleted", (e) => {
    refreshMissions();
  });

  es.addEventListener("mission.aborted", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (currentMissionId && data.missionId === currentMissionId) {
        finalizeStreamingTurn();
        loadMissionDialogue(currentMissionId);
        loadMissionDetails(currentMissionId);
      }
      refreshMissions();
    } catch {}
  });

  es.addEventListener("marketplace.plugin_toggled", () => {
    refreshMarketplace();
  });

  es.onerror = () => {
    setTimeout(connectSse, 5000);
  };
}

// Initial Boot & Session Persistence Recovery
window.addEventListener("DOMContentLoaded", async () => {
  await refreshAll();
  connectSse();

  try {
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get("missionId") || localStorage.getItem("forge_active_mission");
    // Audit fix F-08: never feed an unvalidated id from URL/storage into fetch
    // paths or DOM attributes — ULIDs only.
    if (targetId && /^mis_[A-Za-z0-9]{10,40}$/.test(targetId)) {
      await selectMission(targetId);
    } else if (targetId) {
      localStorage.removeItem("forge_active_mission");
    }
  } catch (err) {
    console.error("Failed to restore active mission session:", err);
  }
});
</script>
</body>
</html>`;
}
