/*
 * CustomAppIcon
 * Use your own picture as the Discord window / taskbar icon (desktop client only).
 * Window icons live in Electron's main process, so the real work happens in native.ts;
 * this file picks the picture, turns it into square PNGs plus a .ico, and hands them over.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { React, showToast } from "@webpack/common";

import { buildIco, IcoImage, toBase64 } from "./ico";
import type { IconResult } from "./native";

const FILE_KEY = "CustomAppIcon_file";
const ICON_SIZE = 256;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, ICON_SIZE];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";

// Undefined in the browser build or until Vencord has been rebuilt with this plugin.
const Native = VencordNative?.pluginHelpers?.CustomAppIcon as PluginNative<typeof import("./native")> | undefined;

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Use my custom icon",
        default: true,
        onChange: () => void apply()
    },
    updateShortcut: {
        type: OptionType.BOOLEAN,
        description: "Windows: also change the icon of Discord's shortcuts (taskbar pin, Start menu, desktop) and app.ico, so the taskbar icon changes (originals are saved)",
        default: true,
        onChange: () => void apply()
    },
    fit: {
        type: OptionType.SELECT,
        description: "How the picture fits into the square icon",
        options: [
            { label: "Fill the square (crops the edges)", value: "cover" },
            { label: "Show the whole picture", value: "contain" }
        ],
        default: "cover",
        onChange: () => void apply()
    },
    round: {
        type: OptionType.BOOLEAN,
        description: "Crop the icon into a circle",
        default: false,
        onChange: () => void apply()
    }
});

let cachedFile: Blob | null = null;
let fileLoaded = false;
let previewUrl: string | null = null;
let status = "";
let iconApplied = false;
let applyToken = 0;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(listener => listener());
}

function setStatus(text: string) {
    status = text;
    notify();
}

function describe(result: IconResult): string {
    const out = [result.window ? "Window icon: set." : "Window icon: not changed."];
    switch (result.shortcutIcon) {
        case "updated":
            out.push("app.ico: updated.");
            break;
        case "unchanged":
            out.push("app.ico: already up to date.");
            break;
        case "restored":
            out.push("app.ico: original restored.");
            break;
        case "error":
            out.push(`Error: ${result.detail ?? "unknown"}`);
            break;
        default:
            out.push("app.ico: not touched (Windows only, or turned off).");
    }
    out.push(...(result.lines ?? []));
    if (result.lines?.some(line => line.includes("updated") || line.includes("restored"))) {
        out.push('Now press "Restart Windows Explorer" below so the taskbar reloads its icons.');
    }
    return out.join("\n");
}

async function getFile(): Promise<Blob | null> {
    if (fileLoaded) return cachedFile;
    fileLoaded = true;
    try {
        const blob = await DataStore.get<Blob>(FILE_KEY);
        if (blob instanceof Blob) cachedFile = blob;
    } catch { /* ignore */ }
    return cachedFile;
}

/** Draw the picture onto a square canvas of the given size. */
function drawSquare(bitmap: ImageBitmap, size: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (settings.store.round) {
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
    }

    const scaleX = size / bitmap.width;
    const scaleY = size / bitmap.height;
    const scale = settings.store.fit === "contain" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    ctx.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);

    return canvas;
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG");
    return new Uint8Array(await blob.arrayBuffer());
}

/** Render the picture as a 256px PNG data URL (window icon, preview) and a multi-size .ico (base64). */
async function renderAll(blob: Blob): Promise<{ dataUrl: string; icoBase64: string; }> {
    const bitmap = await createImageBitmap(blob);
    try {
        const images: IcoImage[] = [];
        let dataUrl = "";
        for (const size of ICO_SIZES) {
            const canvas = drawSquare(bitmap, size);
            if (size === ICON_SIZE) dataUrl = canvas.toDataURL("image/png");
            images.push({ size, png: await canvasToPng(canvas) });
        }
        return { dataUrl, icoBase64: toBase64(buildIco(images)) };
    } finally {
        bitmap.close();
    }
}

/** Put Discord's own icon back. `force` also restores files changed in an earlier session. */
async function restoreDefault(force = false) {
    applyToken++;
    if (!iconApplied && !force) return;
    iconApplied = false;
    if (!Native) return;
    try {
        const result = await Native.restoreIcon();
        setStatus(describe(result));
        if (!result.window) showToast({ text: "Restart Discord to get the original window icon back" });
    } catch (e) {
        console.error("[CustomAppIcon] could not restore the icon", e);
        setStatus("Could not restore the original icon (see the console).");
    }
}

/** Re-read the stored picture and (if enabled) push it to Discord. */
async function apply() {
    const token = ++applyToken;

    const file = await getFile();
    if (token !== applyToken) return;

    if (!file) {
        previewUrl = null;
        notify();
        return;
    }

    let rendered: { dataUrl: string; icoBase64: string; };
    try {
        rendered = await renderAll(file);
    } catch (e) {
        console.error("[CustomAppIcon] could not read the stored picture", e);
        previewUrl = null;
        setStatus("Could not read the stored picture.");
        return;
    }
    if (token !== applyToken) return;

    previewUrl = rendered.dataUrl;
    notify();

    if (!settings.store.enabled) {
        await restoreDefault(true);
        return;
    }
    if (!Native) return;

    try {
        const result = await Native.applyIcon(rendered.dataUrl, settings.store.updateShortcut ? rendered.icoBase64 : null);
        if (token !== applyToken) return;
        if (result.window || result.shortcutIcon === "updated" || result.shortcutIcon === "unchanged") iconApplied = true;
        setStatus(describe(result));
        if (!result.window) console.warn("[CustomAppIcon] the main process did not change the window icon", result);
    } catch (e) {
        console.error("[CustomAppIcon] could not set the icon", e);
        setStatus("Could not set the icon (see the console).");
    }
}

async function useFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
        showToast({ text: "That picture is larger than 10 MB", variant: "critical" });
        return;
    }
    try {
        (await createImageBitmap(file)).close(); // make sure it can actually be decoded
        await DataStore.set(FILE_KEY, file);
        cachedFile = file;
        fileLoaded = true;
        await apply();
        showToast({ text: "Icon updated", variant: "success" });
    } catch {
        showToast({ text: "Could not read that picture", variant: "critical" });
    }
}

async function restartExplorer() {
    try {
        const ok = await Native?.restartExplorer();
        showToast({ text: ok ? "Restarting Windows Explorer..." : "Restarting Explorer only works on Windows" });
    } catch (e) {
        console.error("[CustomAppIcon] could not restart Explorer", e);
        showToast({ text: "Could not restart Windows Explorer", variant: "critical" });
    }
}

function pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPTED_TYPES;
    input.onchange = () => void useFile(input.files?.[0]);
    input.click();
}

async function removePicture() {
    try {
        await DataStore.del(FILE_KEY);
    } catch { /* ignore */ }
    cachedFile = null;
    fileLoaded = true;
    previewUrl = null;
    notify();
    await restoreDefault(true);
}

function IconControls() {
    const [, setTick] = React.useState(0);

    React.useEffect(() => {
        const listener = () => setTick(t => t + 1);
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }, []);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div
                    style={{
                        width: 96, height: 96, borderRadius: 12, overflow: "hidden", flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "var(--background-base-lower, #1e1f22)"
                    }}
                >
                    {previewUrl
                        ? <img src={previewUrl} width={96} height={96} alt="Icon preview" />
                        : <Paragraph>No picture</Paragraph>}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button onClick={pickFile}>Choose picture</Button>
                    <Button variant="secondary" onClick={() => void apply()} disabled={!previewUrl}>
                        Apply again
                    </Button>
                    <Button variant="dangerSecondary" onClick={() => void removePicture()}>
                        Remove / restore original
                    </Button>
                    {Native && navigator.userAgent.includes("Windows") && (
                        <Button variant="secondary" onClick={() => void restartExplorer()}>
                            Restart Windows Explorer
                        </Button>
                    )}
                </div>
            </div>

            {!Native && (
                <Paragraph>
                    The native helper is not loaded, so the icon cannot be changed yet. This only works in the Vencord
                    desktop app. If you just added this plugin, rebuild Vencord (pnpm build) and restart Discord completely.
                </Paragraph>
            )}
            {status && <Paragraph style={{ whiteSpace: "pre-line" }}>{status}</Paragraph>}
            <Paragraph>
                The window icon changes right away. On Windows the taskbar button takes its icon from Discord's shortcut
                (taskbar pin, Start menu or desktop), so this plugin points those shortcuts at your icon and also replaces
                Discord's app.ico. The originals are saved and come back with "Remove". The taskbar only shows the new icon
                after Windows reloads it: use "Restart Windows Explorer" (it also closes open File Explorer windows), or
                unpin and re-pin Discord. If the status says no shortcuts were found, pin Discord to the taskbar first.
            </Paragraph>
        </div>
    );
}

export default definePlugin({
    name: "CustomAppIcon",
    description: "Use your own picture as the Discord window / taskbar icon (desktop only). Choose it in this plugin's settings.",
    authors: [{ name: "me", id: 0n }],

    settings,
    settingsAboutComponent: IconControls,

    start() {
        void apply();
    },

    stop() {
        void restoreDefault();
    }
});
