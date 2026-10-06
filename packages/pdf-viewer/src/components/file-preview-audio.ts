import {
  defineRenderer,
  includesAscii,
  isoBrand,
  startsWithAscii,
} from '@/lib/file-preview-core';

/** ISO-BMFF brands that are sound only. */
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

/**
 * An MPEG audio frame header, checked past its sync word.
 *
 * Eleven set bits alone are too weak — plenty of binary starts `FF Ex` — so the
 * fields a real frame cannot hold are ruled out too: the reserved version and
 * layer, the "bad" bitrate index, and the reserved sample rate.
 */
function isMpegFrame(head: Uint8Array): boolean {
  const [a = 0, b = 0, c = 0] = head;
  if (a !== 0xff || (b & 0xe0) !== 0xe0) return false;
  const version = (b >> 3) & 3;
  const layer = (b >> 1) & 3;
  const bitrate = c >> 4;
  const rate = (c >> 2) & 3;
  return version !== 1 && layer !== 0 && bitrate !== 15 && rate !== 3;
}

/**
 * MP3 by its ID3 tag or frame header, AAC by its ADTS header, M4A by its brand,
 * WAV, FLAC, and Ogg that carries no video.
 *
 * Not audio-only WebM: in 512 bytes it cannot be told from a video, so it goes to
 * the video renderer, which plays sound just as well.
 */
export function sniffAudio(head: Uint8Array): boolean {
  const brand = isoBrand(head);
  if (brand !== undefined) return AUDIO_BRANDS.has(brand);
  return (
    startsWithAscii(head, 'ID3') ||
    isMpegFrame(head) ||
    // ADTS: the same sync word with layer 00, which MPEG audio reserves.
    (head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0) ||
    (startsWithAscii(head, 'RIFF') && startsWithAscii(head, 'WAVE', 8)) ||
    startsWithAscii(head, 'fLaC') ||
    (startsWithAscii(head, 'OggS') && !includesAscii(head, 'theora'))
  );
}

/**
 * Audio, played by the browser's own `<audio>`. No dependencies.
 *
 * Streams rather than downloading, as video does, and refreshes an expired signed
 * link the same way.
 */
export const audioRenderer = defineRenderer({
  id: 'audio',
  label: 'Audio',
  extensions: [
    '.mp3',
    '.m4a',
    '.aac',
    '.wav',
    '.flac',
    '.ogg',
    '.oga',
    '.opus',
  ],
  mimes: ['audio/*'],
  sniff: sniffAudio,
  input: 'url',
  load: () => import('./file-preview-audio-view').then((m) => m.AudioFileView),
});
