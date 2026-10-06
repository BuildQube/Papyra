import {
  defineRenderer,
  includesAscii,
  isoBrand,
  startsWith,
  startsWithAscii,
} from '@/lib/file-preview-core';

/** ISO-BMFF brands that are pictures, which the image renderer owns. */
const IMAGE_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

/** ISO-BMFF brands that are sound only, which the audio renderer owns. */
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

/**
 * MP4 and QuickTime by their brand, WebM and Matroska by their EBML header, and Ogg
 * only when it carries a Theora stream — an Ogg file is far more often Vorbis or
 * Opus, which is audio.
 *
 * AVI is deliberately not claimed: no browser plays it, and "No preview" with a
 * download beats a player that shows an error.
 */
export function sniffVideo(head: Uint8Array): boolean {
  const brand = isoBrand(head);
  if (brand !== undefined) {
    return !IMAGE_BRANDS.has(brand) && !AUDIO_BRANDS.has(brand);
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return true;
  return startsWithAscii(head, 'OggS') && includesAscii(head, 'theora');
}

/**
 * Video, played by the browser's own `<video>`. No dependencies.
 *
 * Streams rather than downloading: the view gets a URL, and a remote file is never
 * fetched whole — only its first 512 bytes, to recognise it. A signed link that
 * expires mid-playback is refreshed and playback resumes where it was.
 *
 * Which codecs play is the browser's call: H.264 and VP9 nearly everywhere, HEVC in
 * Safari, AV1 in most current browsers.
 */
export const videoRenderer = defineRenderer({
  id: 'video',
  label: 'Video',
  extensions: ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'],
  mimes: ['video/*'],
  sniff: sniffVideo,
  input: 'url',
  load: () => import('./file-preview-video-view').then((m) => m.VideoFileView),
});
