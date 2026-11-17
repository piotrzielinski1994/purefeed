import type { DetectedPost, PlatformAdapter } from '../adapters/adapter.ts';
import type { PostKey } from '../shared/types.ts';

const MEDIA_ATTRIBUTES = ['src', 'srcset', 'poster'];
const MEDIA_SELECTOR = 'img, video';

export type PostScanner = { scanNow(): void; disconnect(): void };

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const isContainer = (node: Node): node is Element | Document | DocumentFragment =>
  isElement(node) || node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE;

const hasMedia = (nodes: NodeList): boolean =>
  [...nodes].some((node) => isElement(node) && (node.matches(MEDIA_SELECTOR) || node.querySelector(MEDIA_SELECTOR) !== null));

export function createPostScanner(opts: {
  root: Node;
  adapter: Pick<PlatformAdapter, 'postSelector' | 'readPost'>;
  onPost: (p: DetectedPost) => void;
  onKeyChanged: (el: Element, oldKey: PostKey) => void;
}): PostScanner {
  const { root, adapter } = opts;
  const keys = new WeakMap<Element, PostKey>();

  const visit = (el: Element, isMediaChange: boolean) => {
    const post = adapter.readPost(el);
    if (!post) {
      return;
    }
    const oldKey = keys.get(el);
    if (oldKey === post.postKey && !isMediaChange) {
      return;
    }
    if (oldKey !== undefined && oldKey !== post.postKey) {
      opts.onKeyChanged(el, oldKey);
    }
    keys.set(el, post.postKey);
    opts.onPost(post);
  };

  const postsIn = (node: Node): Element[] => {
    if (!isContainer(node)) {
      return [];
    }
    const self = isElement(node) && node.matches(adapter.postSelector) ? [node] : [];
    return [...self, ...node.querySelectorAll(adapter.postSelector)];
  };

  const onMutations = (records: MutationRecord[]) => {
    const changed = new Map<Element, boolean>();
    const mark = (el: Element | null | undefined, isMediaChange: boolean) => {
      if (el) {
        changed.set(el, (changed.get(el) ?? false) || isMediaChange);
      }
    };
    records.forEach((record) => {
      const owner = isElement(record.target) ? record.target.closest(adapter.postSelector) : null;
      if (record.type === 'attributes') {
        mark(owner, true);
        return;
      }
      mark(owner, hasMedia(record.addedNodes));
      record.addedNodes.forEach((node) => {
        postsIn(node).forEach((el) => {
          mark(el, false);
        });
      });
    });
    changed.forEach((isMediaChange, el) => {
      visit(el, isMediaChange);
    });
  };

  const observer = new MutationObserver(onMutations);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: MEDIA_ATTRIBUTES });

  return {
    scanNow() {
      postsIn(root).forEach((el) => {
        visit(el, false);
      });
    },
    disconnect() {
      observer.disconnect();
    },
  };
}
