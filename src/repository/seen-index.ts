import type { Comparison, Fingerprint, ImageFingerprint, MatchClass, RecordId, Thresholds } from '../shared/types.ts';
import { compareFingerprints } from '../similarity/compare.ts';
import { HASH_BITS, hamming64, similarityFromDistance } from '../similarity/hamming.ts';
import type { SeenRecord } from './seen-record.ts';

export type IndexMatch = { id: RecordId; record: SeenRecord; comparison: Comparison };

const HASH_WORDS = 2;
const CROP_COUNT = 16;
const SLOT_WORDS = HASH_WORDS + CROP_COUNT * HASH_WORDS;
const GAP_WORDS = 3;
const INITIAL_SLOTS = 1024;
const DISTANCES = Array.from({ length: HASH_BITS + 1 }, (_, d) => d);
const CLASS_RANK: Record<MatchClass, number> = { exact: 2, near: 1, different: 0 };

const gapSetOf = (gaps: readonly number[]): Uint32Array =>
  gaps.reduce((set, gap) => {
    set[gap >>> 5] |= 1 << (gap & 31);
    return set;
  }, new Uint32Array(GAP_WORDS));

const isBetter = (m: IndexMatch, best: IndexMatch | null): boolean =>
  best === null ||
  CLASS_RANK[m.comparison.matchClass] > CLASS_RANK[best.comparison.matchClass] ||
  (m.comparison.matchClass === best.comparison.matchClass && m.comparison.similarity > best.comparison.similarity);

export class SeenIndex {
  readonly #records = new Map<RecordId, SeenRecord>();
  readonly #imageSlots = new Map<RecordId, number>();
  readonly #otherIds = new Set<RecordId>();
  #imageIds: RecordId[] = [];
  #imageWords = new Uint32Array(INITIAL_SLOTS * SLOT_WORDS);
  #cropGaps = new Uint8Array(INITIAL_SLOTS * CROP_COUNT);
  #gapSets = new Uint32Array(INITIAL_SLOTS * GAP_WORDS);

  get size(): number {
    return this.#records.size;
  }

  get(id: RecordId): SeenRecord | undefined {
    return this.#records.get(id);
  }

  upsert(id: RecordId, record: SeenRecord): void {
    const { fingerprint } = record;
    const slot = this.#imageSlots.get(id);
    if (fingerprint.kind !== 'image') {
      this.#removeImageSlot(id);
      this.#otherIds.add(id);
    } else {
      this.#otherIds.delete(id);
      this.#writeImageSlot(slot ?? this.#appendImageSlot(id), fingerprint);
    }
    this.#records.set(id, record);
  }

  remove(ids: RecordId[]): void {
    ids.forEach((id) => {
      this.#removeImageSlot(id);
      this.#otherIds.delete(id);
      this.#records.delete(id);
    });
  }

  clear(): void {
    this.#records.clear();
    this.#imageSlots.clear();
    this.#otherIds.clear();
    this.#imageIds = [];
  }

  findBest(fp: Fingerprint, t: Thresholds): IndexMatch | null {
    const candidates = fp.kind === 'image' ? this.#imageCandidates(fp, t) : [...this.#otherIds];
    return candidates.reduce<IndexMatch | null>((best, id) => {
      const record = this.#records.get(id);
      if (!record) {
        return best;
      }
      const comparison = compareFingerprints(fp, record.fingerprint, t);
      const match = { id, record, comparison };
      return comparison.matchClass !== 'different' && isBetter(match, best) ? match : best;
    }, null);
  }

  idsLastSeenBefore(cutoffMs: number): RecordId[] {
    return [...this.#records].filter(([, record]) => record.lastSeenAt < cutoffMs).map(([id]) => id);
  }

  #imageCandidates(fp: ImageFingerprint, t: Thresholds): RecordId[] {
    const maxDistance = DISTANCES.findLast((d) => similarityFromDistance(d) >= t.near) ?? -1;
    const queryGaps = Array.from({ length: CROP_COUNT }, (_, i) => hamming64(fp.crops, HASH_WORDS * i, fp.hash, 0));
    const isNear = (gap: number, direct: number): boolean => Math.abs(gap - direct) <= maxDistance;
    const nearGaps = Uint8Array.from(DISTANCES.flatMap((direct) => DISTANCES.map((gap) => (isNear(gap, direct) ? 1 : 0))));
    const queryCropsAt = DISTANCES.map((direct) => queryGaps.flatMap((gap, i) => (isNear(gap, direct) ? [i] : [])));
    const windows = DISTANCES.map((direct) => gapSetOf(DISTANCES.filter((gap) => isNear(gap, direct))));
    const words = this.#imageWords;
    const gaps = this.#cropGaps;
    const gapSets = this.#gapSets;
    const candidates: RecordId[] = [];
    for (let slot = 0; slot < this.#imageIds.length; slot++) {
      const base = slot * SLOT_WORDS;
      const direct = hamming64(fp.hash, 0, words, base);
      const queryCrops = queryCropsAt[direct];
      const window = windows[direct];
      const setBase = slot * GAP_WORDS;
      const isRecordCropReachable =
        (gapSets[setBase] & window[0]) !== 0 || (gapSets[setBase + 1] & window[1]) !== 0 || (gapSets[setBase + 2] & window[2]) !== 0;
      let isClose = direct <= maxDistance;
      for (let k = 0; k < queryCrops.length && !isClose; k++) {
        isClose = hamming64(fp.crops, HASH_WORDS * queryCrops[k], words, base) <= maxDistance;
      }
      const gapBase = slot * CROP_COUNT;
      const nearRow = direct * DISTANCES.length;
      for (let i = 0; i < CROP_COUNT && isRecordCropReachable && !isClose; i++) {
        isClose = nearGaps[nearRow + gaps[gapBase + i]] === 1 && hamming64(fp.hash, 0, words, base + HASH_WORDS * (i + 1)) <= maxDistance;
      }
      if (isClose) {
        candidates.push(this.#imageIds[slot]);
      }
    }
    return candidates;
  }

  #appendImageSlot(id: RecordId): number {
    const slot = this.#imageIds.length;
    if ((slot + 1) * SLOT_WORDS > this.#imageWords.length) {
      const grownWords = new Uint32Array(this.#imageWords.length * 2);
      const grownGaps = new Uint8Array(this.#cropGaps.length * 2);
      const grownGapSets = new Uint32Array(this.#gapSets.length * 2);
      grownWords.set(this.#imageWords);
      grownGaps.set(this.#cropGaps);
      grownGapSets.set(this.#gapSets);
      this.#imageWords = grownWords;
      this.#cropGaps = grownGaps;
      this.#gapSets = grownGapSets;
    }
    this.#imageIds.push(id);
    this.#imageSlots.set(id, slot);
    return slot;
  }

  #writeImageSlot(slot: number, fp: ImageFingerprint): void {
    const base = slot * SLOT_WORDS;
    this.#imageWords.set(fp.hash.subarray(0, HASH_WORDS), base);
    this.#imageWords.set(fp.crops.subarray(0, CROP_COUNT * HASH_WORDS), base + HASH_WORDS);
    const gaps = Array.from({ length: CROP_COUNT }, (_, i) => hamming64(fp.crops, HASH_WORDS * i, fp.hash, 0));
    this.#cropGaps.set(gaps, slot * CROP_COUNT);
    this.#gapSets.set(gapSetOf(gaps), slot * GAP_WORDS);
  }

  #removeImageSlot(id: RecordId): void {
    const slot = this.#imageSlots.get(id);
    if (slot === undefined) {
      return;
    }
    const last = this.#imageIds.length - 1;
    const lastId = this.#imageIds[last];
    this.#imageWords.copyWithin(slot * SLOT_WORDS, last * SLOT_WORDS, (last + 1) * SLOT_WORDS);
    this.#cropGaps.copyWithin(slot * CROP_COUNT, last * CROP_COUNT, (last + 1) * CROP_COUNT);
    this.#gapSets.copyWithin(slot * GAP_WORDS, last * GAP_WORDS, (last + 1) * GAP_WORDS);
    this.#imageIds[slot] = lastId;
    this.#imageSlots.set(lastId, slot);
    this.#imageIds.pop();
    this.#imageSlots.delete(id);
  }
}
