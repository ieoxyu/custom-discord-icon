/*
 * Tiny helpers for building a Windows .ico file in the renderer.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface IcoImage {
    /** Edge length in pixels (the image is square). */
    size: number;
    /** The image as PNG bytes. */
    png: Uint8Array;
}

/** Build a .ico that holds PNG-compressed images (supported by Windows since Vista). */
export function buildIco(images: IcoImage[]): Uint8Array {
    const count = images.length;
    const headerSize = 6 + 16 * count;
    const total = images.reduce((sum, image) => sum + image.png.length, headerSize);

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0, true); // reserved
    view.setUint16(2, 1, true); // type 1 = icon
    view.setUint16(4, count, true);

    let offset = headerSize;
    images.forEach(({ size, png }, index) => {
        const entry = 6 + 16 * index;
        const edge = size >= 256 ? 0 : size; // 0 means 256
        out[entry] = edge; // width
        out[entry + 1] = edge; // height
        out[entry + 2] = 0; // palette colours
        out[entry + 3] = 0; // reserved
        view.setUint16(entry + 4, 1, true); // colour planes
        view.setUint16(entry + 6, 32, true); // bits per pixel
        view.setUint32(entry + 8, png.length, true);
        view.setUint32(entry + 12, offset, true);
        out.set(png, offset);
        offset += png.length;
    });

    return out;
}

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
