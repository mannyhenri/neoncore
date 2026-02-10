# GRIDLIGHT App Style Guide

This document defines the visual design standards, color palette, and application requirements for building Gridlight applications. All internal apps should follow these guidelines for a consistent user experience.

---

## Table of Contents

1. [App Requirements](#app-requirements)
2. [Directory Structure](#directory-structure)
3. [Manifest File](#manifest-file)
4. [Color Palette](#color-palette)
5. [Typography](#typography)
6. [Backgrounds & Surfaces](#backgrounds--surfaces)
7. [CRT & Retro Effects](#crt--retro-effects)
8. [Neon Glow Effects](#neon-glow-effects)
9. [Buttons & Interactive Elements](#buttons--interactive-elements)
10. [Status Indicators](#status-indicators)
11. [Custom Scrollbars](#custom-scrollbars)
12. [Animations](#animations)
13. [Spacing & Layout](#spacing--layout)
14. [CSS Variables Reference](#css-variables-reference)

---

## App Requirements

Every Gridlight app must include:

| File | Required | Description |
|------|----------|-------------|
| `gridlight.json` | Yes | App manifest with metadata and configuration |
| `src/index.html` | Yes | Frontend entry point |
| `src/assets/icon.svg` | Recommended | App icon (SVG preferred, PNG accepted) |
| `README.md` | Optional | Documentation for developers |

### App Types

| Type | Description | Backend Required |
|------|-------------|------------------|
| `standalone` | Single-page HTML app loaded via `file://` | No |
| `hybrid` | App with a backend server process | Yes |

---

## Directory Structure

### Standalone App
```
my-app/
├── gridlight.json          # App manifest (required)
├── README.md               # Documentation (optional)
└── src/
    ├── index.html          # Entry point (required)
    ├── styles.css          # Styles (optional, can be inline)
    ├── app.js              # JavaScript (optional, can be inline)
    └── assets/
        ├── icon.svg        # App icon
        └── background.png  # Background image (optional)
```

### Hybrid App
```
my-app/
├── gridlight.json          # App manifest (required)
├── README.md               # Documentation (optional)
├── package.json            # Node.js dependencies
├── src/
│   ├── index.html          # Frontend entry
│   └── assets/
│       └── icon.svg
└── backend/
    ├── server.js           # Backend entry point
    └── package.json        # Backend dependencies
```

---

## Manifest File

The `gridlight.json` manifest tells Gridlight how to display, launch, and manage the app.

### Minimal Example (Standalone)
```json
{
  "name": "My App",
  "version": "1.0.0",
  "short_description": "Brief description for the app card",
  "entry": "src/index.html",
  "runtime": "1.0",
  "type": "standalone",
  "icon": "src/assets/icon.svg"
}
```

### Full Example (Hybrid)
```json
{
  "name": "My Hybrid App",
  "version": "1.0.0",
  "short_description": "Brief description for the app card",
  "detailed_description": "Longer description with full feature details",
  "usage_instructions": "How to use the app",
  "author": "Gridlight",
  "icon": "src/assets/icon.svg",
  "entry": "src/index.html",
  "runtime": "1.0",
  "type": "hybrid",
  "gridlight_version_required": "0.6.2",
  "backend": {
    "entry": "backend/server.js",
    "port": 3001,
    "install": "npm install"
  },
  "permissions": ["network", "storage", "clipboard"],
  "window": {
    "width": 1200,
    "height": 800
  }
}
```

### Key Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name (shown in app card and title bar) |
| `version` | string | Yes | Semantic version (e.g., `"1.0.0"`) |
| `short_description` | string | No | 1-2 sentences for app card |
| `entry` | string | Yes | Relative path to frontend HTML |
| `runtime` | string | Yes | Always `"1.0"` |
| `type` | string | Yes | `"standalone"` or `"hybrid"` |
| `icon` | string | No | Relative path to icon file |
| `window.width` | number | No | Initial width (default: 1500) |
| `window.height` | number | No | Initial height (default: 875) |

---

## Color Palette

### Primary Colors

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Background (Dark)** | `#0a0a0f` | `rgb(10, 10, 15)` | Desktop app shell, darkest background |
| **Background** | `#0f0f23` | `rgb(15, 15, 35)` | Page background (chat apps) |
| **Surface Dark** | `#0d0d14` | `rgb(13, 13, 20)` | Code blocks, terminal backgrounds |
| **Surface Header** | `#12121a` | `rgb(18, 18, 26)` | Headers, navigation bars |
| **Surface** | `#1a1a2e` | `rgb(26, 26, 46)` | Cards, panels, containers |
| **Surface Elevated** | `#252542` | `rgb(37, 37, 66)` | Elevated elements, hover states |

### Brand Gradients

**Primary Gradient (Chat Apps)** - Pink to Blue diagonal:
```css
background: linear-gradient(135deg, #e91e63 0%, #2196f3 100%);
```

**Desktop Gradient** - Pink through Purple to Blue horizontal:
```css
background: linear-gradient(to right, #ec4899, #a855f7, #3b82f6);
/* Tailwind: bg-gradient-to-r from-pink-500 via-purple-500 to-blue-500 */
```

**Destructive Gradient** - Red through Rose to Pink:
```css
background: linear-gradient(to right, #ef4444, #f43f5e, #ec4899);
/* Tailwind: bg-gradient-to-r from-red-500 via-rose-500 to-pink-500 */
```

| Gradient | Colors | Usage |
|----------|--------|-------|
| Primary (Chat) | `#e91e63` → `#2196f3` | Chat app primary actions |
| Primary (Desktop) | `#ec4899` → `#a855f7` → `#3b82f6` | Desktop app buttons, progress bars |
| Destructive | `#ef4444` → `#f43f5e` → `#ec4899` | Stop buttons, destructive actions |

### Accent Colors

| Name | Hex | Usage |
|------|-----|-------|
| **Purple (Primary Accent)** | `#a855f7` | Tab highlights, focus states, interactive elements |
| **Pink** | `#ec4899` | Notification badges, alerts |
| **Blue** | `#3b82f6` | Links, info states |

### Text Colors

| Name | Hex | Usage |
|------|-----|-------|
| **Primary Text** | `#ffffff` | Main content, headings |
| **Secondary Text** | `#aaaaaa` | Descriptions, labels |
| **Muted Text** | `#888888` | Timestamps, hints |
| **Disabled Text** | `#666666` | Disabled states |

### Status Colors

| Status | Hex | Gradient | Usage |
|--------|-----|----------|-------|
| **Success** | `#22c55e` | `linear-gradient(135deg, #22c55e, #16a34a)` | Success states, confirmations |
| **Neon Green** | `#00ff88` | — | Monitor online status, real-time indicators |
| **Error** | `#ef4444` | `linear-gradient(135deg, #ef4444, #dc2626)` | Errors, destructive actions |
| **Neon Red** | `#ff4444` | — | Monitor offline status, critical alerts |
| **Warning** | `#f59e0b` | `linear-gradient(135deg, #f59e0b, #d97706)` | Warnings, cautions |
| **Info** | `#3b82f6` | `linear-gradient(135deg, #3b82f6, #2563eb)` | Information, processing |

### Feature Accent Colors

| Name | Hex | Usage |
|------|-----|-------|
| **Intelligent/AI** | `#22c55e` | AI-related features, intelligent mode |
| **RAG/Knowledge** | `#8b5cf6` | Knowledge base features, RAG queries |
| **Creative** | `#f97316` | Creative/generation features |
| **Analysis** | `#06b6d4` | Analytics, data visualization |
| **Purple Accent** | `#a855f7` | Active tabs, focused elements |
| **Pink Accent** | `#ec4899` | Notifications, badges |

---

## Typography

### Font Stack

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
             'Helvetica Neue', Arial, sans-serif;
```

For code/monospace:
```css
font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', Consolas,
             'Courier New', monospace;
```

### Font Sizes

| Element | Size | Weight | Line Height |
|---------|------|--------|-------------|
| H1 | 24px | 600 | 1.3 |
| H2 | 20px | 600 | 1.3 |
| H3 | 16px | 600 | 1.4 |
| Body | 14px | 400 | 1.5 |
| Small | 12px | 400 | 1.4 |
| Caption | 11px | 400 | 1.3 |

---

## Backgrounds & Surfaces

### Page Background

```css
body {
  background-color: #0f0f23;
  background-image: url('assets/background.png');
  background-size: cover;
  background-position: center;
  background-attachment: fixed;
}
```

### Glass Effect (Frosted Glass)

For cards and containers with blur effect:

```css
.card {
  background: rgba(15, 15, 35, 0.86);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
}
```

### Surface Variants

```css
/* Standard surface */
.surface {
  background: rgba(26, 26, 46, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* Elevated surface (hover, active) */
.surface-elevated {
  background: rgba(37, 37, 66, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

/* Input fields */
.input-surface {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
}

/* Input focus state */
.input-surface:focus {
  background: rgba(255, 255, 255, 0.12);
  border-color: #e91e63;
  box-shadow: 0 0 0 2px rgba(233, 30, 99, 0.2);
}
```

---

## CRT & Retro Effects

Gridlight uses retro CRT-inspired visual effects for an 80s aesthetic. These are optional but add to the brand identity.

### Scanline Overlay

Apply to the root container for a subtle CRT monitor effect:

```css
/* Full-screen scanline overlay via ::before pseudo-element */
.crt-overlay {
  position: relative;
  overflow: hidden;
}

.crt-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.15),
    rgba(0, 0, 0, 0.15) 1px,
    transparent 1px,
    transparent 2px
  );
  pointer-events: none;
  z-index: 9999;
  animation: crt-flicker 0.15s infinite;
}

@keyframes crt-flicker {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.98; }
}
```

### Tab Bar Scanlines

Lighter scanlines for navigation bars:

```css
.tab-bar-retro {
  position: relative;
}

.tab-bar-retro::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    transparent 0px,
    transparent 2px,
    rgba(0, 0, 0, 0.05) 2px,
    rgba(0, 0, 0, 0.05) 4px
  );
}
```

---

## Neon Glow Effects

### Icon Glow (Active State)

For active navigation icons with neon glow:

```css
/* Neon glow on active icon — drop-shadow follows SVG stroke paths */
.icon-active svg {
  filter:
    drop-shadow(0 0 2px currentColor)
    drop-shadow(0 0 6px currentColor)
    drop-shadow(0 0 12px rgba(168, 85, 247, 0.4));
}

.icon-inactive svg {
  filter: none;
}

/* Scale bump for active icon */
.icon-active {
  transform: scale(1.15);
}

.icon-active,
.icon-inactive {
  transition: transform 0.2s ease, filter 0.3s ease, color 0.3s ease;
}
```

### Text Glow (Active Labels)

```css
.label-active {
  text-shadow:
    0 0 4px rgba(168, 85, 247, 0.6),
    0 0 8px rgba(168, 85, 247, 0.3);
}
```

### Notification Badge Glow

```css
/* Number badge */
.badge-notification {
  min-width: 14px;
  height: 14px;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
  border-radius: 7px;
  padding: 0 3px;
  background: linear-gradient(135deg, #ec4899, #8b5cf6);
  color: white;
  box-shadow: 0 0 6px rgba(236, 72, 153, 0.6);
}

/* Dot indicator */
.badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ec4899;
  box-shadow: 0 0 6px rgba(236, 72, 153, 0.6);
}
```

### Status Indicator Glow

```css
/* Online/success indicator */
.status-online {
  background: #00ff88;
  box-shadow: 0 0 8px rgba(0, 255, 136, 0.5);
}

/* Offline/error indicator */
.status-offline {
  background: #ff4444;
  box-shadow: 0 0 8px rgba(255, 68, 68, 0.5);
}
```

---

## Buttons & Interactive Elements

### Primary Button (Gradient)

```css
.btn-primary {
  background: linear-gradient(135deg, #e91e63 0%, #2196f3 100%);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(233, 30, 99, 0.3);
}

.btn-primary:active {
  transform: translateY(0);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
```

### Secondary Button

```css
.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 10px 20px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}
```

### Icon Button

```css
.btn-icon {
  background: transparent;
  color: #aaaaaa;
  border: none;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-icon:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}
```

### Destructive Button

```css
.btn-destructive {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
}

.btn-destructive:hover {
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
}
```

---

## Status Indicators

### Badges

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.badge-success {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.badge-error {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.badge-warning {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.badge-info {
  background: rgba(59, 130, 246, 0.2);
  color: #3b82f6;
}
```

### Loading Spinner

```css
.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-top-color: #e91e63;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

### Progress Bar

```css
.progress-bar {
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #e91e63, #2196f3);
  transition: width 0.3s ease;
}

/* Desktop-style progress (pink-purple-blue) */
.progress-bar-fill-desktop {
  height: 100%;
  background: linear-gradient(to right, #ec4899, #a855f7, #3b82f6);
  transition: width 0.3s ease;
}
```

---

## Custom Scrollbars

Gridlight uses custom styled scrollbars with purple accent.

### Standard Scrollbar

```css
.scroll-area::-webkit-scrollbar {
  width: 6px;
}

.scroll-area::-webkit-scrollbar-track {
  background: transparent;
}

.scroll-area::-webkit-scrollbar-thumb {
  background: rgba(147, 51, 234, 0.4);
  border-radius: 3px;
}

.scroll-area::-webkit-scrollbar-thumb:hover {
  background: rgba(147, 51, 234, 0.6);
}
```

### Hidden Scrollbar

For areas where you want scrolling but no visible scrollbar:

```css
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
```

---

## Animations

### Slide-In (Panel Entry)

```css
@keyframes slide-in-from-right {
  from {
    transform: translateX(40px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.animate-slide-in {
  animation: slide-in-from-right 0.25s ease-out;
}
```

### Toast Countdown

Progress bar animation for auto-dismissing toasts:

```css
.toast-progress {
  animation: toast-countdown linear forwards;
  transform-origin: left;
}

@keyframes toast-countdown {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}
```

### Pulse (Loading)

```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.animate-pulse {
  animation: pulse 2s ease-in-out infinite;
}
```

### CRT Flicker

Subtle flicker for retro effect (already shown in CRT section):

```css
@keyframes crt-flicker {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.98; }
}
```

---

## Spacing & Layout

### Spacing Scale

| Name | Value | Usage |
|------|-------|-------|
| `xs` | 4px | Tight spacing |
| `sm` | 8px | Small gaps |
| `md` | 16px | Standard spacing |
| `lg` | 24px | Section spacing |
| `xl` | 32px | Large gaps |
| `2xl` | 48px | Major sections |

### Border Radius

| Name | Value | Usage |
|------|-------|-------|
| `sm` | 4px | Small elements |
| `md` | 8px | Buttons, inputs |
| `lg` | 12px | Cards |
| `xl` | 16px | Large cards, modals |
| `full` | 9999px | Pills, avatars |

### Shadows

```css
/* Subtle shadow */
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);

/* Medium shadow */
box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);

/* Strong shadow (modals, dropdowns) */
box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);

/* Glow effect (accent elements) */
box-shadow: 0 0 20px rgba(233, 30, 99, 0.3);
```

---

## CSS Variables Reference

Include these variables at the root of your app for consistent theming:

```css
:root {
  /* Background Colors */
  --gl-bg-darkest: #0a0a0f;           /* Desktop app shell */
  --gl-bg-primary: #0f0f23;           /* Standard page background */
  --gl-bg-code: #0d0d14;              /* Code blocks, terminals */
  --gl-bg-header: #12121a;            /* Headers, nav bars */
  --gl-bg-surface: #1a1a2e;           /* Cards, panels */
  --gl-bg-elevated: #252542;          /* Hover states */

  /* Glass Effects */
  --gl-glass-bg: rgba(15, 15, 35, 0.86);
  --gl-glass-bg-light: rgba(26, 26, 46, 0.6);
  --gl-glass-border: rgba(255, 255, 255, 0.1);

  /* Brand Colors */
  --gl-brand-pink: #e91e63;
  --gl-brand-purple: #a855f7;
  --gl-brand-blue: #2196f3;

  /* Brand Gradients */
  --gl-brand-gradient: linear-gradient(135deg, #e91e63 0%, #2196f3 100%);
  --gl-brand-gradient-desktop: linear-gradient(to right, #ec4899, #a855f7, #3b82f6);
  --gl-brand-gradient-destructive: linear-gradient(to right, #ef4444, #f43f5e, #ec4899);

  /* Text Colors */
  --gl-text-primary: #ffffff;
  --gl-text-secondary: #aaaaaa;
  --gl-text-muted: #888888;
  --gl-text-disabled: #666666;

  /* Status Colors */
  --gl-success: #22c55e;
  --gl-success-neon: #00ff88;         /* Bright neon green */
  --gl-error: #ef4444;
  --gl-error-neon: #ff4444;           /* Bright neon red */
  --gl-warning: #f59e0b;
  --gl-info: #3b82f6;

  /* Accent Colors */
  --gl-accent-purple: #a855f7;        /* Primary accent (tabs, focus) */
  --gl-accent-pink: #ec4899;          /* Notifications, badges */
  --gl-accent-ai: #22c55e;
  --gl-accent-rag: #8b5cf6;
  --gl-accent-creative: #f97316;
  --gl-accent-analysis: #06b6d4;

  /* Neon Glow Colors (for box-shadow) */
  --gl-glow-purple: rgba(168, 85, 247, 0.4);
  --gl-glow-pink: rgba(236, 72, 153, 0.6);
  --gl-glow-green: rgba(0, 255, 136, 0.5);
  --gl-glow-red: rgba(255, 68, 68, 0.5);

  /* Borders */
  --gl-border-subtle: rgba(255, 255, 255, 0.08);
  --gl-border-default: rgba(255, 255, 255, 0.15);
  --gl-border-focus: #e91e63;
  --gl-border-focus-purple: #a855f7;

  /* Scrollbar */
  --gl-scrollbar-thumb: rgba(147, 51, 234, 0.4);
  --gl-scrollbar-thumb-hover: rgba(147, 51, 234, 0.6);

  /* Spacing */
  --gl-space-xs: 4px;
  --gl-space-sm: 8px;
  --gl-space-md: 16px;
  --gl-space-lg: 24px;
  --gl-space-xl: 32px;
  --gl-space-2xl: 48px;

  /* Border Radius */
  --gl-radius-sm: 4px;
  --gl-radius-md: 8px;
  --gl-radius-lg: 12px;
  --gl-radius-xl: 16px;
  --gl-radius-2xl: 24px;
  --gl-radius-full: 9999px;

  /* Typography */
  --gl-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                  'Helvetica Neue', Arial, sans-serif;
  --gl-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', Consolas,
                  'Courier New', monospace;

  /* Transitions */
  --gl-transition-fast: 0.15s ease;
  --gl-transition-normal: 0.2s ease;
  --gl-transition-slow: 0.3s ease;
}
```

---

## Quick Start Template

### Basic Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Gridlight App</title>
  <style>
    :root {
      --gl-bg-primary: #0f0f23;
      --gl-bg-surface: #1a1a2e;
      --gl-glass-bg: rgba(15, 15, 35, 0.86);
      --gl-glass-border: rgba(255, 255, 255, 0.1);
      --gl-brand-gradient: linear-gradient(135deg, #e91e63 0%, #2196f3 100%);
      --gl-text-primary: #ffffff;
      --gl-text-secondary: #aaaaaa;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: var(--gl-bg-primary);
      color: var(--gl-text-primary);
      min-height: 100vh;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }

    .card {
      background: var(--gl-glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--gl-glass-border);
      border-radius: 16px;
      padding: 24px;
    }

    .btn-primary {
      background: var(--gl-brand-gradient);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(233, 30, 99, 0.3);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>My Gridlight App</h1>
      <p style="color: var(--gl-text-secondary); margin: 16px 0;">
        Your app content goes here.
      </p>
      <button class="btn-primary">Get Started</button>
    </div>
  </div>
</body>
</html>
```

### Template with CRT Effect

Add retro CRT scanlines and flicker for the full Gridlight aesthetic:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Gridlight App</title>
  <style>
    :root {
      --gl-bg-darkest: #0a0a0f;
      --gl-bg-surface: #1a1a2e;
      --gl-glass-bg: rgba(26, 26, 46, 0.6);
      --gl-glass-border: rgba(255, 255, 255, 0.1);
      --gl-brand-gradient: linear-gradient(to right, #ec4899, #a855f7, #3b82f6);
      --gl-text-primary: #ffffff;
      --gl-text-secondary: #aaaaaa;
      --gl-accent-purple: #a855f7;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: var(--gl-bg-darkest);
      color: var(--gl-text-primary);
      min-height: 100vh;
    }

    /* CRT Overlay */
    .crt-overlay {
      position: relative;
      overflow: hidden;
      min-height: 100vh;
    }

    .crt-overlay::before {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, 0.15),
        rgba(0, 0, 0, 0.15) 1px,
        transparent 1px,
        transparent 2px
      );
      pointer-events: none;
      z-index: 9999;
      animation: crt-flicker 0.15s infinite;
    }

    @keyframes crt-flicker {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.98; }
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
      position: relative;
      z-index: 1;
    }

    .card {
      background: var(--gl-glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--gl-glass-border);
      border-radius: 16px;
      padding: 24px;
    }

    .btn-primary {
      background: var(--gl-brand-gradient);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(168, 85, 247, 0.4);
    }

    /* Neon glow on focus */
    .btn-primary:focus {
      outline: none;
      box-shadow:
        0 0 0 2px var(--gl-bg-darkest),
        0 0 0 4px var(--gl-accent-purple),
        0 0 20px rgba(168, 85, 247, 0.4);
    }
  </style>
</head>
<body>
  <div class="crt-overlay">
    <div class="container">
      <div class="card">
        <h1>My Gridlight App</h1>
        <p style="color: var(--gl-text-secondary); margin: 16px 0;">
          Your app content goes here with retro CRT effects.
        </p>
        <button class="btn-primary">Get Started</button>
      </div>
    </div>
  </div>
</body>
</html>
```

---

## Branding Guidelines

### Text Usage
- Use **GRIDLIGHT** (all caps) for headers, titles, and logos
- Use **Gridlight** (title case) for body text, descriptions, and prose
- Never use "GridLight" (camelCase)

### Brand Assets

The following brand assets are included in the `docs/` folder:

| File | Description | Usage |
|------|-------------|-------|
| `background.png` | Dark space/grid background image | Page backgrounds, hero sections |
| `logo.png` | Gridlight logo mark (icon only) | App icons, favicons, small branding |
| `name_grid.png` | Gridlight wordmark with grid styling | Headers, splash screens, marketing |

#### Background Image Usage

```css
body {
  background-color: #0f0f23;
  background-image: url('docs/background.png');
  background-size: cover;
  background-position: center;
  background-attachment: fixed;
}
```

#### Logo Usage

```html
<!-- Icon/logo mark -->
<img src="docs/logo.png" alt="Gridlight" width="48" height="48">

<!-- Full wordmark -->
<img src="docs/name_grid.png" alt="GRIDLIGHT" height="32">
```

---

## Design Philosophy

Gridlight's visual identity draws inspiration from:

- **Retro 80s Aesthetics**: CRT scanlines, neon glows, and subtle flicker effects
- **Cyberpunk/Synthwave**: Pink-purple-blue gradients, dark backgrounds
- **Modern Glass Morphism**: Frosted glass cards with backdrop blur
- **High Contrast for Accessibility**: White text on dark backgrounds with clear status colors

When building apps, aim for:
- Dark, immersive interfaces that don't strain the eyes
- Subtle retro effects that enhance without distracting
- Clear visual hierarchy using color and glow
- Smooth, purposeful animations

---

*This style guide is based on the Gridlight design system, desktop application patterns, and gridlight-chat application styles.*
