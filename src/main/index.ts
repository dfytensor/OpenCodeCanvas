import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { stopServer } from './opencode/server'
import { readSettings } from './settings'

// restore persisted settings before any window/service boots
const bootSettings = readSettings()
if (bootSettings.openrouterKey) process.env.OPENROUTER_API_KEY = bootSettings.openrouterKey

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'OpenCode Canvas',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  // user looked at the app — stop flashing the taskbar
  mainWindow.on('focus', () => mainWindow?.flashFrame(false))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite dev server vs production build
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL']
    // dev-only scripted GUI automation (?auto=1) — see renderer/automation.ts
    mainWindow.loadURL(
      process.env.OCC_AUTOMATION === '1'
        ? url + '/?auto=1' + (process.env.OCC_AUTO_SUITE ? '&suite=' + process.env.OCC_AUTO_SUITE : '')
        : url
    )
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // automation result sink: the in-page script reports through document.title
  if (process.env.OCC_AUTOMATION === '1') {
    const out = join(app.getPath('temp'), 'occ-auto-result.log')
    let last = ''
    const { appendFileSync } = require('fs') as typeof import('fs')
    const iv = setInterval(() => {
      const t = mainWindow?.webContents.getTitle() ?? ''
      if (t.startsWith('OCC-AUTOTEST') && t !== last) {
        last = t
        try {
          appendFileSync(out, `${new Date().toISOString().slice(11, 19)} ${t}\n`, 'utf8')
        } catch {
          // ignore
        }
      }
    }, 2000)
    mainWindow.on('closed', () => clearInterval(iv))
  }
}

app.whenReady().then(() => {
  // GUI-automation hook (dev only): enable CDP for external driving/tests
  if (process.env.OCC_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.OCC_CDP_PORT)
  }
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void stopServer()
})
