import sharp from 'sharp';
import { resolve } from 'path';
import { mkdir } from 'fs/promises';

const src = resolve(process.env.ECHOWRITE_ICON_SOURCE || 'public/icons/icon128.png');
const sizes = [16, 32, 48, 128];

await mkdir(resolve('public/icons'), { recursive: true });
await mkdir(resolve('icons'), { recursive: true });
await mkdir(resolve('dist/icons'), { recursive: true });

for (const targetDir of ['public/icons', 'icons', 'dist/icons']) {
  for (const size of sizes) {
    await sharp(src)
      .resize(size, size)
      .png()
      .toFile(resolve(`${targetDir}/icon${size}.png`));
    console.log(`✅ ${targetDir}/icon${size}.png`);
  }
}

console.log('Done!');
