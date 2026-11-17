# PureFeed

## Limitations

- Video frames come only from the page's own playback: the extension never downloads video bytes. A video gets a frame sequence fingerprint only after the page plays it (Reddit and X autoplay muted videos in the feed). Before playback, and for a cross-origin video without pixel access (for example an X GIF video on `video.twimg.com`), the video has a poster-only fingerprint, which matches only another poster-only fingerprint and only at `exact`.
