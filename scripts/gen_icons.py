#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 official-icon.png 转成 Tauri 需要的全套图标（纯标准库实现）

产出：
  icons/32x32.png
  icons/128x128.png
  icons/128x128@2x.png  (256)
  icons/icon.png        (512)
  icons/icon.ico        (多尺寸，Windows 必需)

PNG 方面只做「按需缩放」——原图已是 512x512，直接复用/最近邻缩放。
ICO 直接内嵌 PNG 数据（Vista+ 支持）。
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
# HERE = <项目>/win-build/src-tauri  ->  项目根 = 上两级
SRC = os.path.join(os.path.dirname(os.path.dirname(HERE)), "official-icon.png")
ICON_DIR = os.path.join(HERE, "icons")


# ---------------------------------------------------------------- PNG 读写

def png_read(path):
    """极简 PNG 解码，支持 8bit RGB/RGBA、非隔行"""
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"

    pos = 8
    width = height = None
    bit_depth = color_type = None
    idat = b""
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", body[:10])
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln

    assert bit_depth == 8, f"只支持 8bit，实际 {bit_depth}"
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    raw = zlib.decompress(idat)

    stride = width * channels
    out = bytearray(width * height * channels)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        # 反滤波
        if ft == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line

    # 统一转 RGBA
    rgba = bytearray(width * height * 4)
    if channels == 4:
        rgba = out
    elif channels == 3:
        for i in range(width * height):
            rgba[i * 4:i * 4 + 3] = out[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
    elif channels == 1:
        for i in range(width * height):
            v = out[i]
            rgba[i * 4:i * 4 + 3] = bytes([v, v, v])
            rgba[i * 4 + 3] = 255
    else:
        raise ValueError("不支持的通道数")
    return width, height, bytes(rgba)


def png_write(path, w, h, rgba):
    raw = b"".join(
        b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h)
    )

    def chunk(tag, body):
        c = struct.pack(">I", len(body)) + tag + body
        return c + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def resize(src_w, src_h, src, dst_w, dst_h):
    """双线性缩放"""
    out = bytearray(dst_w * dst_h * 4)
    for dy in range(dst_h):
        fy = (dy + 0.5) * src_h / dst_h - 0.5
        y0 = max(0, int(fy))
        y1 = min(src_h - 1, y0 + 1)
        wy = fy - y0 if fy >= 0 else 0.0
        for dx in range(dst_w):
            fx = (dx + 0.5) * src_w / dst_w - 0.5
            x0 = max(0, int(fx))
            x1 = min(src_w - 1, x0 + 1)
            wx = fx - x0 if fx >= 0 else 0.0
            for c in range(4):
                p00 = src[(y0 * src_w + x0) * 4 + c]
                p10 = src[(y0 * src_w + x1) * 4 + c]
                p01 = src[(y1 * src_w + x0) * 4 + c]
                p11 = src[(y1 * src_w + x1) * 4 + c]
                top = p00 + (p10 - p00) * wx
                bot = p01 + (p11 - p01) * wx
                out[(dy * dst_w + dx) * 4 + c] = int(top + (bot - top) * wy + 0.5)
    return bytes(out)


# ---------------------------------------------------------------- ICO

def build_ico(png_by_size, out_path):
    sizes = sorted(png_by_size.keys())
    count = len(sizes)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    blobs = b""
    offset = 6 + 16 * count

    for s in sizes:
        data = png_by_size[s]
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)

    with open(out_path, "wb") as f:
        f.write(header + entries + blobs)
    return len(header + entries + blobs)


# ---------------------------------------------------------------- 主流程

if __name__ == "__main__":
    print(f"源文件: {SRC}")
    sw, sh, src = png_read(SRC)
    print(f"源尺寸: {sw}x{sh}")
    print()

    targets = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "icon.png": (512, 512),
    }
    cache = {}
    for name, (w, h) in targets.items():
        if (sw, sh) == (w, h):
            rgba = src
        else:
            rgba = resize(sw, sh, src, w, h)
        p = os.path.join(ICON_DIR, name)
        n = png_write(p, w, h, rgba)
        print(f"  {name:<18} {w}x{h}  {n} bytes")
        cache[w] = rgba

    # ICO：内嵌各尺寸 PNG
    ico_pngs = {}
    for s in (16, 24, 32, 48, 64, 128, 256):
        if s in cache:
            rgba = cache[s]
        else:
            rgba = resize(sw, sh, src, s, s)
        tmp = os.path.join(ICON_DIR, f"_tmp_{s}.png")
        png_write(tmp, s, s, rgba)
        with open(tmp, "rb") as f:
            ico_pngs[s] = f.read()
        os.remove(tmp)

    ico_path = os.path.join(ICON_DIR, "icon.ico")
    n = build_ico(ico_pngs, ico_path)
    print(f"  icon.ico           {n} bytes  ({len(ico_pngs)} 个尺寸)")
    print()
    print("全部图标生成完成")
