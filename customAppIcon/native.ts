/*
 * CustomAppIcon (native half)
 * Runs in Discord's Electron *main* process, so it can touch the real window icon, Discord's
 * own icon files and Discord's shortcuts, which a renderer-only plugin cannot.
 *
 * Why several steps on Windows:
 *  - BrowserWindow.setIcon changes the live window icon (Alt-Tab and similar).
 *  - The taskbar button, however, takes its icon from Discord's *shortcut* (.lnk): the taskbar
 *    pin, the Start menu entry or the desktop shortcut. Windows also caches icons by file path,
 *    so overwriting the same file is often not noticed. We therefore point each Discord shortcut
 *    at a freshly named .ico, and also replace Discord's app.ico (used when Discord re-creates
 *    its shortcuts after an update). Originals are saved so "Remove" can put everything back.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, win32 } from "path";

import { app, BrowserWindow, IpcMainInvokeEvent, nativeImage, shell } from "electron";

export interface IconResult {
    /** Was the live window icon changed? */
    window: boolean;
    /** What happened to Discord's app.ico files. */
    shortcutIcon: "updated" | "unchanged" | "restored" | "skipped" | "error";
    /** Notes about Discord's shortcuts (taskbar pin, Start menu, desktop), one per shortcut. */
    lines?: string[];
    detail?: string;
}

// The renderer sends a 256x256 PNG as a data URL. Be strict about what we accept:
// these handlers are reachable from any script running inside the Discord window.
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_PNG_DATA_URL_LENGTH = 4 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_ICO_BYTES = 2 * 1024 * 1024;
const MAX_ICO_BASE64_LENGTH = Math.ceil(MAX_ICO_BYTES / 3) * 4;

const BACKUP_SUFFIX = ".custom-icon-backup";
const CUSTOM_ICON_PREFIX = "custom-app-icon-";
const CUSTOM_ICON_NAME = /^custom-app-icon-[0-9a-f]{10}\.ico$/;
const SHORTCUT_STATE_FILE = "custom-icon-shortcuts.json";

type ShortcutState = Record<string, { icon: string; iconIndex: number; }>;

function getTargetWindows(event: IpcMainInvokeEvent) {
    const own = BrowserWindow.fromWebContents(event.sender);
    return own ? [own] : BrowserWindow.getAllWindows();
}

function applyImage(event: IpcMainInvokeEvent, image: Electron.NativeImage) {
    // Windows + Linux: the window icon.
    for (const win of getTargetWindows(event)) {
        if (!win.isDestroyed()) win.setIcon(image);
    }
    // macOS has no per-window icon, only the dock icon.
    if (process.platform === "darwin") app.dock?.setIcon(image);
}

/**
 * Discord (Squirrel) installs like  %LOCALAPPDATA%\Discord\app-1.0.XXXX\Discord.exe.
 * Returns the Discord folder (the one that contains Update.exe) or null for any other layout.
 */
function getDiscordRoot(): string | null {
    if (process.platform !== "win32") return null;
    const appDir = dirname(process.execPath);
    if (!/^app-/i.test(basename(appDir))) return null;
    return dirname(appDir);
}

// ---------- app.ico ----------

/** Discord keeps an app.ico next to the exe and one folder up. Only touch files that already exist. */
function getAppIcoFiles(): string[] {
    const root = getDiscordRoot();
    if (!root) return [];
    return [join(root, "app.ico"), join(dirname(process.execPath), "app.ico")].filter(file => existsSync(file));
}

function writeAppIcos(ico: Buffer): IconResult["shortcutIcon"] {
    const files = getAppIcoFiles();
    if (!files.length) return "skipped";

    let updated = 0;
    for (const file of files) {
        const backup = file + BACKUP_SUFFIX;
        if (!existsSync(backup)) copyFileSync(file, backup);
        if (readFileSync(file).equals(ico)) continue;
        writeFileSync(file, ico);
        updated++;
    }
    return updated ? "updated" : "unchanged";
}

function restoreAppIcos(): IconResult["shortcutIcon"] {
    let restored = 0;
    for (const file of getAppIcoFiles()) {
        const backup = file + BACKUP_SUFFIX;
        if (!existsSync(backup)) continue;
        copyFileSync(backup, file);
        unlinkSync(backup);
        restored++;
    }
    return restored ? "restored" : "skipped";
}

// ---------- shortcuts (.lnk) ----------

function isInside(child: string | undefined, parent: string) {
    if (!child) return false;
    const folder = win32.normalize(parent).replace(/[\\/]+$/, "").toLowerCase() + win32.sep;
    return win32.normalize(child).toLowerCase().startsWith(folder);
}

function samePath(a: string | undefined, b: string) {
    return !!a && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
}

interface ShortcutLocation { label: string; dir: string; depth: number; }

function getShortcutLocations(): ShortcutLocation[] {
    const locations: ShortcutLocation[] = [];
    const appData = process.env.APPDATA;
    if (appData) {
        locations.push({
            label: "Taskbar pin",
            dir: join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
            depth: 0
        });
        locations.push({
            label: "Start menu",
            dir: join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
            depth: 1
        });
    }
    try {
        locations.push({ label: "Desktop", dir: app.getPath("desktop"), depth: 0 });
    } catch { /* no desktop folder */ }
    return locations;
}

function findDiscordLinks(dir: string, depth: number): string[] {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isFile() && /discord.*\.lnk$/i.test(entry.name)) found.push(full);
        else if (entry.isDirectory() && depth > 0) found.push(...findDiscordLinks(full, depth - 1));
    }
    return found;
}

function readShortcutState(root: string): ShortcutState {
    try {
        const parsed = JSON.parse(readFileSync(join(root, SHORTCUT_STATE_FILE), "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeShortcutState(root: string, state: ShortcutState) {
    const file = join(root, SHORTCUT_STATE_FILE);
    if (Object.keys(state).length) writeFileSync(file, JSON.stringify(state, null, 2));
    else if (existsSync(file)) unlinkSync(file);
}

function removeCustomIcons(root: string, keep?: string) {
    let names: string[] = [];
    try {
        names = readdirSync(root);
    } catch { /* ignore */ }
    for (const name of names) {
        if (!CUSTOM_ICON_NAME.test(name) || join(root, name) === keep) continue;
        try {
            unlinkSync(join(root, name));
        } catch { /* ignore */ }
    }
}

/** Point every Discord shortcut at a freshly named .ico. Returns one note per shortcut. */
function updateShortcuts(root: string, ico: Buffer): string[] {
    const hash = createHash("sha1").update(ico).digest("hex").slice(0, 10);
    const icoPath = join(root, `${CUSTOM_ICON_PREFIX}${hash}.ico`);
    if (!existsSync(icoPath)) writeFileSync(icoPath, ico);

    const state = readShortcutState(root);
    const lines: string[] = [];
    let allCurrent = true;

    for (const location of getShortcutLocations()) {
        for (const link of findDiscordLinks(location.dir, location.depth)) {
            let details: Electron.ShortcutDetails;
            try {
                details = shell.readShortcutLink(link);
            } catch {
                continue;
            }
            if (!isInside(details.target, root)) continue; // not one of Discord's shortcuts

            if (samePath(details.icon, icoPath)) {
                lines.push(`${location.label}: already up to date`);
                continue;
            }

            if (!state[link]) {
                // remember the original icon once; if it already is one of ours (state was lost) fall back to the exe
                const ours = !!details.icon && CUSTOM_ICON_NAME.test(basename(details.icon));
                state[link] = ours || !details.icon
                    ? { icon: "", iconIndex: 0 }
                    : { icon: details.icon, iconIndex: details.iconIndex ?? 0 };
            }

            let ok = false;
            try {
                ok = shell.writeShortcutLink(link, "update", { ...details, icon: icoPath, iconIndex: 0 });
            } catch { /* reported below */ }
            if (!ok) allCurrent = false;
            lines.push(`${location.label}: ${ok ? "icon updated" : "could not be updated"}`);
        }
    }

    if (!lines.length) {
        lines.push("No Discord shortcuts found. Pin Discord to the taskbar (or create a desktop shortcut), then press Apply again");
    }

    writeShortcutState(root, state);
    if (allCurrent) removeCustomIcons(root, icoPath);
    return lines;
}

function restoreShortcuts(root: string): string[] {
    const state = readShortcutState(root);
    const lines: string[] = [];
    let allRestored = true;

    for (const [link, original] of Object.entries(state)) {
        if (!existsSync(link)) {
            delete state[link];
            continue;
        }
        let ok = false;
        try {
            const details = shell.readShortcutLink(link);
            const icon = original.icon || details.target;
            const iconIndex = original.icon ? original.iconIndex : 0;
            ok = shell.writeShortcutLink(link, "update", { ...details, icon, iconIndex });
        } catch { /* reported below */ }

        if (ok) delete state[link];
        else allRestored = false;
        lines.push(`${basename(link)}: ${ok ? "original icon restored" : "could not be restored"}`);
    }

    writeShortcutState(root, state);
    if (allRestored) removeCustomIcons(root);
    return lines;
}

// ---------- IPC entry points ----------

/** Set the window icon from a PNG data URL and (Windows) the shortcut icons from an .ico. */
export async function applyIcon(event: IpcMainInvokeEvent, pngDataUrl: string, icoBase64: string | null): Promise<IconResult> {
    if (typeof pngDataUrl !== "string" || pngDataUrl.length > MAX_PNG_DATA_URL_LENGTH || !PNG_DATA_URL.test(pngDataUrl)) {
        return { window: false, shortcutIcon: "skipped", detail: "invalid PNG" };
    }

    const image = nativeImage.createFromDataURL(pngDataUrl);
    if (image.isEmpty()) return { window: false, shortcutIcon: "skipped", detail: "empty image" };
    applyImage(event, image);

    const result: IconResult = { window: true, shortcutIcon: "skipped" };
    if (typeof icoBase64 === "string" && icoBase64.length <= MAX_ICO_BASE64_LENGTH && BASE64.test(icoBase64)) {
        const ico = Buffer.from(icoBase64, "base64");
        // 00 00 01 00 = ICO header (reserved = 0, type = 1)
        const looksLikeIco = ico.length > 22 && ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1;
        const root = getDiscordRoot();
        if (looksLikeIco && root) {
            try {
                result.shortcutIcon = writeAppIcos(ico);
                result.lines = updateShortcuts(root, ico);
            } catch (e) {
                result.shortcutIcon = "error";
                result.detail = String(e);
            }
        }
    }
    return result;
}

/** Undo applyIcon: put Discord's own icons back and, on Windows, refresh the window icon. */
export async function restoreIcon(event: IpcMainInvokeEvent): Promise<IconResult> {
    const result: IconResult = { window: false, shortcutIcon: "skipped" };

    try {
        result.shortcutIcon = restoreAppIcos();
        const root = getDiscordRoot();
        if (root) result.lines = restoreShortcuts(root);
    } catch (e) {
        result.shortcutIcon = "error";
        result.detail = String(e);
    }

    if (process.platform === "win32") {
        try {
            const image = await app.getFileIcon(process.execPath, { size: "large" });
            if (!image.isEmpty()) {
                applyImage(event, image);
                result.window = true;
            }
        } catch { /* the original window icon then returns after restarting Discord */ }
    }
    return result;
}

/**
 * Restart Windows Explorer so the taskbar reloads its icons. Fixed command, no user input.
 * This also closes any open File Explorer windows.
 */
export async function restartExplorer(_event: IpcMainInvokeEvent): Promise<boolean> {
    if (process.platform !== "win32") return false;
    await new Promise<void>(resolve => execFile("taskkill", ["/f", "/im", "explorer.exe"], () => resolve()));
    spawn("explorer.exe", [], { detached: true, stdio: "ignore" }).unref();
    return true;
}
