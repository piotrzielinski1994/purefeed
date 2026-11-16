import type { Comparison, Fingerprint, MatchClass, Thresholds } from '../shared/types.ts';
import { guardRejects } from './caption-guard.ts';
import { hamming64, similarityFromDistance } from './hamming.ts';
import { bestImageSimilarity } from './image-similarity.ts';
import { isExactSequence, orderedMatchPercent } from './sequence.ts';

const NEAR_SEQUENCE_PERCENT = 60;
const NO_MATCH: Comparison = { matchClass: 'different', similarity: 0 };

export function classifySimilarity(similarity: number, t: Thresholds): MatchClass {
  if (similarity >= t.exact) {
    return 'exact';
  }
  return similarity >= t.near ? 'near' : 'different';
}

export function compareFingerprints(a: Fingerprint, b: Fingerprint, t: Thresholds): Comparison {
  if (a.kind === 'image' && b.kind === 'image') {
    const { similarity, alignment } = bestImageSimilarity(a, b);
    const matchClass = classifySimilarity(similarity, t);
    const isRejected = matchClass !== 'different' && guardRejects(a.edges, b.edges, alignment);
    return { matchClass: isRejected ? 'different' : matchClass, similarity };
  }
  if (a.kind === 'sequence' && b.kind === 'sequence') {
    const similarity = orderedMatchPercent(a, b, t.near);
    if (isExactSequence(a, b, t.exact)) {
      return { matchClass: 'exact', similarity };
    }
    return { matchClass: similarity >= NEAR_SEQUENCE_PERCENT ? 'near' : 'different', similarity };
  }
  if (a.kind === 'poster' && b.kind === 'poster') {
    const similarity = similarityFromDistance(hamming64(a.hash, 0, b.hash, 0));
    return { matchClass: similarity >= t.exact ? 'exact' : 'different', similarity };
  }
  return NO_MATCH;
}
