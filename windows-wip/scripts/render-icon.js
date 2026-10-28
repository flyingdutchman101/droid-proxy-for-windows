// Renders resources/icon.svg into resources/icon.png (512px) and a multi-size
// resources/icon.ico (PNG-compressed entries). Run with: npm run icon
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

const resources = path.join(__dirname, "..", "resources");
const svg = fs.readFileSync(path.join(resources, "icon.svg"), "utf8");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function renderPng(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  const sized = image.getSize().width === size ? image : image.resize({ width: size, height: size, quality: "best" });
  return sized.toPNG();
}

// ICO with PNG payloads (supported since Windows Vista).
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((item) => item.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  // One render, then downscale: repeated offscreen windows fail to load intermittently.
  const big = await renderPng(512);
  fs.writeFileSync(path.join(resources, "icon.png"), big);
  const source = nativeImage.createFromBuffer(big);
  const pngs = ICO_SIZES.map((size) => ({ size, data: source.resize({ width: size, height: size, quality: "best" }).toPNG() }));
  fs.writeFileSync(path.join(resources, "icon.ico"), buildIco(pngs));
  console.log(`icon.png (512) and icon.ico (${ICO_SIZES.join(", ")}) written`);
  app.quit();
});
