import { app, BrowserWindow, dialog, shell } from 'electron';

let server;
let mainWindow;

async function createWindow() {
  try {
    process.env.APP_DATA_DIR = app.getPath('userData');
    process.env.PORT = process.env.PORT || '0';

    const { startServer } = await import('../server.js');
    server = await startServer(Number(process.env.PORT));
    const port = server.actualPort || process.env.PORT;

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: 'AI Image Generator',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  } catch (error) {
    dialog.showErrorBox('启动失败', error?.message || String(error));
    app.quit();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (server) server.close();
});
