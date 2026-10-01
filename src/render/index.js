// Template -> SVG (Satori) -> PNG (resvg) -> JPEG (sharp). No headless
// browser, no paid design API, no image-generation API.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { settings } from "../config.js";
import { buildElement } from "./templates.js";

const assetCache = new Map();

function brandAssets(biz) {
  const key = biz.assetsDir;
  if (assetCache.has(key)) return assetCache.get(key);
  const brand = biz.profile.brand;
  const fonts = brand.fonts.map((f) => ({
    name: brand.font_family,
    data: fs.readFileSync(path.join(biz.assetsDir, f.file)),
    weight: f.weight,
    style: "normal",
  }));
  const logoPath = path.join(biz.assetsDir, brand.logo);
  const logo = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
  const assets = { fonts, logo };
  assetCache.set(key, assets);
  return assets;
}

export function mediaDir(slug) {
  const dir = path.join(settings.dataDir, "media", slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Public URL Instagram will download the image from. */
export function mediaUrl(slug, file) {
  return `${settings.publicBaseUrl}/media/${slug}/${path.basename(file)}`;
}

/**
 * Renders one creative. Returns the absolute path of the JPEG.
 * The random suffix keeps media URLs unguessable and cache-busted on re-render.
 */
export async function renderCreative(biz, { template, fields, date, type, outFile }) {
  const { fonts, logo } = brandAssets(biz);
  const element = buildElement(template, fields, { profile: biz.profile, logo });
  const width = 1080;
  const height = type === "story" ? 1920 : 1350;
  const svg = await satori(element, { width, height, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng();
  const file = outFile || path.join(mediaDir(biz.slug), `${date}-${type}-${crypto.randomBytes(5).toString("hex")}.jpg`);
  await sharp(png).flatten({ background: "#000000" }).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" }).toFile(file);
  return file;
}
