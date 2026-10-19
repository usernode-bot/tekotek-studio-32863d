// MP4 export in the browser via Remotion's web renderer (WebCodecs + H.264).
import {renderMediaOnWeb} from '@remotion/web-renderer';

// Feature-check first: a recent Chrome, Edge or Safari is needed. When this
// answers false the app keeps Export disabled and says so.
export async function webCodecsH264Supported(width, height, fps) {
  try {
    if (typeof VideoEncoder === 'undefined') return false;
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width,
      height,
      bitrate: 3_000_000,
      framerate: fps,
    });
    return !!support.supported;
  } catch {
    return false;
  }
}

export async function exportMp4({composition, inputProps, signal, onProgress}) {
  const result = await renderMediaOnWeb({
    composition,
    inputProps,
    videoCodec: 'h264',
    container: 'mp4',
    signal,
    onProgress: (p) => {
      if (onProgress) onProgress(p.progress);
    },
  });
  return result.getBlob();
}