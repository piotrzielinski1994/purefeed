import type { ContentType } from '../shared/types.ts';
import type { DetectedMedia } from './adapter.ts';

const MIN_MEDIA_PX = 150;
const MEDIA_TAGS: ReadonlySet<string> = new Set(['img', 'video']);

export function renderedSize(el: Element): { width: number; height: number } {
  const { width, height } = el.getBoundingClientRect();
  return { width, height };
}

export function isMediaItem(el: Element): boolean {
  const { width, height } = renderedSize(el);
  return MEDIA_TAGS.has(el.localName) && width >= MIN_MEDIA_PX && height >= MIN_MEDIA_PX;
}

export function absoluteUrl(href: string | null | undefined, base: Node): string | null {
  if (!href) {
    return null;
  }
  const baseUrl = base.ownerDocument?.baseURI ?? base.baseURI;
  return URL.canParse(href, baseUrl) ? new URL(href, baseUrl).href : null;
}

export const imageMedia = (el: HTMLImageElement): DetectedMedia => ({ el, contentType: 'image', posterUrl: null });

export const firstMatch = (pattern: RegExp, value: string | null | undefined): string | null => pattern.exec(value ?? '')?.[1] ?? null;

export const isImage = (el: Element): el is HTMLImageElement => el.localName === 'img';

export const isVideo = (el: Element): el is HTMLVideoElement => el.localName === 'video';

export function elementMedia(el: Element, videoType: ContentType): DetectedMedia[] {
  if (isImage(el)) {
    return [imageMedia(el)];
  }
  return isVideo(el) ? [{ el, contentType: videoType, posterUrl: absoluteUrl(el.getAttribute('poster'), el) }] : [];
}
