export const PLATFORM_HOSTS = ['www.reddit.com', 'wykop.pl', 'x.com'] as const;

export const MEDIA_HOSTS = [
  'i.redd.it',
  'preview.redd.it',
  'external-preview.redd.it',
  'wykop.pl',
  'pbs.twimg.com',
  'video.twimg.com',
] as const;

const toMatchPattern = (host: string): string => `https://${host}/*`;

export const PLATFORM_MATCHES: readonly string[] = PLATFORM_HOSTS.map(toMatchPattern);

export const HOST_PERMISSIONS: readonly string[] = [...new Set([...PLATFORM_HOSTS, ...MEDIA_HOSTS])].map(toMatchPattern);
