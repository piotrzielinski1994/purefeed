# PureFeed

## Limitations

- Video network transfer: fingerprinting 8 frames of a video can transfer more than 25% of the file, and with repeated range requests more than the whole file. Each frame needs the bytes from the keyframe before it, and Chrome reads open-ended byte ranges. Measured on the 10 MB E2E (end-to-end) fixture `big.mp4` (4 Mbit/s, keyframe every 2.5 s): 14.2 MB to 16.8 MB (142% to 169% of the file).
