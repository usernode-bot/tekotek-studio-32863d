// MP4 export in the browser via Remotion's web renderer (WebCodecs + H.264).
import {renderMediaOnWeb} from '@remotion/web-renderer';

// Feature-check first. The export is an MP4; H.264 is the codec of choice
// (recent Chrome, Edge and Safari all encode it), and the same MP4 container
// also takes VP9, which browsers without proprietary codecs (some Chromium
// builds) can still encode. When neither is possible the app keeps Export
// disabled and says so.
// The H.264 string asks for exactly what the web renderer (mediabunny
// underneath) encodes: High profile, level picked from the frame's
// macroblock count — for the app's fixed 1080×1920 at this bitrate that is
// level 4.0 → avc1.640028. The old baseline-level string (avc1.42001f) caps
// near 720p, so even able browsers answered "unsupported".
export async function pickVideoCodec(width, height, fps) {
  if (typeof VideoEncoder === 'undefined') return 'none';
  const can = async (codec) => {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: 3_000_000,
        framerate: fps,
      });
      return !!support.supported;
    } catch {
      return false;
    }
  };
  if (await can('avc1.640028')) return 'h264';
  if (await can('vp09.00.10.08')) return 'vp9';
  return 'none';
}

export async function exportMp4({composition, inputProps, signal, onProgress, videoCodec}) {
  const result = await renderMediaOnWeb({
    composition,
    inputProps,
    videoCodec: videoCodec || 'h264',
    container: 'mp4',
    signal,
    onProgress: (p) => {
      if (onProgress) onProgress(p.progress);
    },
  });
  return result.getBlob();
}