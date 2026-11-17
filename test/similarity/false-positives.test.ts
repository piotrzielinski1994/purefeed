import { describe, expect, it } from 'vitest';
import type { GrayImage, Thresholds } from '../../src/shared/types.ts';
import { loadGray } from '../helpers/assets.ts';

const loadCompare = () => import('../../src/similarity/compare.ts');
const loadFingerprint = () => import('../../src/fingerprint/image-fingerprint.ts');
const ASSET_TEST = { timeout: 120_000 };
const DEFAULTS: Thresholds = { exact: 95, near: 90 };

async function classifyImages(a: GrayImage, b: GrayImage): Promise<[string, string]> {
  const { compareFingerprints } = await loadCompare();
  const { fingerprintImage } = await loadFingerprint();
  const [fa, fb] = [fingerprintImage(a), fingerprintImage(b)];
  if (!fa || !fb) throw new Error('no fingerprint');
  return [compareFingerprints(fa, fb, DEFAULTS).matchClass, compareFingerprints(fb, fa, DEFAULTS).matchClass];
}

const classify = (a: string, b: string): Promise<[string, string]> => classifyImages(loadGray(a), loadGray(b));

type Block = { x: number; y: number; width: number; height: number };

const LOGO_SIDE = 134;
const TEXT_BLOCK = { width: 100, height: 60 };
const BLOCK_WHITE = 250;

const textPattern = (x: number, y: number): number => (((x >> 2) + (y >> 2)) % 2 === 1 ? 255 : 0);

function withBlock(image: GrayImage, block: Block, paint: (x: number, y: number) => number): GrayImage {
  const isInside = (x: number, y: number): boolean => x >= block.x && x < block.x + block.width && y >= block.y && y < block.y + block.height;
  const data = image.data.map((value, i) => {
    const x = i % image.width;
    const y = Math.floor(i / image.width);
    return isInside(x, y) ? paint(x, y) : value;
  });
  return { ...image, data };
}

describe('false-positive guard on generated assets (AC-027, AC-028)', () => {
  it('should return different if caption-a.png and caption-b.png share the picture but not the caption', ASSET_TEST, async () => {
    expect(await classify('caption-a.png', 'caption-b.png')).toEqual(['different', 'different']);
  });

  it('should return different if the caption text area of caption-a.png changes by 1% of the image', ASSET_TEST, async () => {
    expect(await classify('caption-a.png', 'caption-a-small.png')).toEqual(['different', 'different']);
  });

  it('should return different if screenshot-1.png and screenshot-2.png share layout, size and background', ASSET_TEST, async () => {
    expect(await classify('screenshot-1.png', 'screenshot-2.png')).toEqual(['different', 'different']);
  });

  it('should return exact if a caption meme or a screenshot is compared with itself', ASSET_TEST, async () => {
    for (const name of ['caption-a.png', 'screenshot-1.png']) expect(await classify(name, name), name).toEqual(['exact', 'exact']);
  });
});

describe('added overlays count as different content (AC-011, AC-027)', () => {
  it('should return different if a text block on 1.7% of the area is added in any corner of caption-a.png', ASSET_TEST, async () => {
    const original = loadGray('caption-a.png');
    const far = { x: original.width - TEXT_BLOCK.width - 20, y: original.height - TEXT_BLOCK.height - 20 };
    const corners: Block[] = [
      { x: 20, y: 20, ...TEXT_BLOCK },
      { x: far.x, y: 20, ...TEXT_BLOCK },
      { x: 20, y: far.y, ...TEXT_BLOCK },
      { x: far.x, y: far.y, ...TEXT_BLOCK },
    ];
    const results = await Promise.all(corners.map((block) => classifyImages(original, withBlock(original, block, textPattern))));
    expect(results).toEqual(corners.map(() => ['different', 'different']));
  });

  it('should return different if base.png gets a 5% block in a corner, the centre, the right or the bottom', ASSET_TEST, async () => {
    const original = loadGray('base.png');
    const logo = { width: LOGO_SIDE, height: LOGO_SIDE };
    const blocks: Record<string, Block> = {
      'top-left corner': { x: 10, y: 10, ...logo },
      'top-right corner': { x: 456, y: 10, ...logo },
      'bottom-left corner': { x: 10, y: 456, ...logo },
      centre: { x: 233, y: 233, ...logo },
      'right middle': { x: 456, y: 233, ...logo },
      'bottom-centre band 400x45': { x: 100, y: 540, width: 400, height: 45 },
    };
    const entries = Object.entries(blocks);
    const white = (block: Block): GrayImage => withBlock(original, block, () => BLOCK_WHITE);
    const results = await Promise.all(entries.map(([, block]) => classifyImages(original, white(block))));
    expect(Object.fromEntries(entries.map(([name], i) => [name, results[i]]))).toEqual(
      Object.fromEntries(entries.map(([name]) => [name, ['different', 'different']])),
    );
  });
});

describe('match class regression on generated assets (AC-010, AC-011, AC-023)', () => {
  it('should return exact if base.png is compared with its resized, recompressed and converted copies', ASSET_TEST, async () => {
    const copies = ['base-25.png', 'base-50.png', 'base-200.png', 'base-400.png', 'base-q30.jpg', 'base-q60.jpg', 'base-q95.jpg'];
    for (const name of [...copies, 'base.webp', 'base.avif', 'base.bmp', 'base-static.gif']) {
      expect(await classify('base.png', name), name).toEqual(['exact', 'exact']);
    }
  });

  it('should return a match for the cropped copy of base.png and different for its copy with a logo', ASSET_TEST, async () => {
    for (const matchClass of await classify('base.png', 'crop-l10-tb5.png')) expect(['exact', 'near']).toContain(matchClass);
    expect(await classify('base.png', 'logo5.png')).toEqual(['different', 'different']);
  });

  it('should return near if base.png is compared with its copy cropped 7% from the right', ASSET_TEST, async () => {
    expect(await classify('base.png', 'crop-r7.png')).toEqual(['near', 'near']);
  });

  it('should return different if unrelated control images are compared with base.png or with each other', ASSET_TEST, async () => {
    const names = ['base.png', 'other-1.png', 'other-2.png', 'other-3.png'];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        expect(await classify(names[i], names[j]), `${names[i]} vs ${names[j]}`).toEqual(['different', 'different']);
      }
    }
  });
});
