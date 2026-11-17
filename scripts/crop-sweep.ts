import { loadGray } from '../test/helpers/assets.ts';
import { type CropResult, cropShapes, isMatch, sweepCrops } from '../test/helpers/crop-sweep.ts';

const shapeLabel = ({ shape }: CropResult): string => `${shape.left},${shape.right},${shape.top},${shape.bottom}`;

if (import.meta.main) {
  const base = loadGray('base.png');
  const results = sweepCrops(base, cropShapes(base));
  const keys = results.map((r) => r.classes.join('/'));
  const classes = Object.fromEntries([...new Set(keys)].map((key) => [key, keys.filter((k) => k === key).length]));
  const matched = results.filter(isMatch).length;
  console.log(JSON.stringify({ shapes: results.length, matched, matchedPercent: (100 * matched) / results.length, classes }));
  console.log(
    `not matched (left,right,top,bottom px): ${results
      .filter((r) => !isMatch(r))
      .map(shapeLabel)
      .join(' ')}`,
  );
}
