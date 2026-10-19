// Tekotek Studio: turn a product into a ready 15-second shoppable video.
// One screen: add a product's images, name and price, get a voiceover script
// written for you, watch the 9:16 preview, export it as an MP4.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {
  PromoVideo,
  FPS,
  DURATION,
  DURATION_FRAMES,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  timelineLayout,
} from './PromoVideo';
import {exportMp4, pickVideoCodec} from './export';

const MAX_IMAGES = 5;
const DEMO_FRAME = 360; // the demo preview sits paused at 0:12

const TOKEN = new URLSearchParams(window.location.search).get('token') || '';
// The platform signs the app in with ?token= on the iframe URL; API calls
// carry it the same way (the header is kept for callers that forward it).
const apiUrl = (path) =>
  TOKEN ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : path;
const apiHeaders = () => {
  const h = {'content-type': 'application/json'};
  if (TOKEN) h['x-usernode-token'] = TOKEN;
  return h;
};

const DEMO = {
  name: 'Glow Serum 30ml',
  price: '$18.90',
  badge: 'Today only',
  script:
    'Tired of dull skin? Meet Glow Serum. One drop a day and you see it in a week. Only $18.90 today. Tap the yellow cart before it sells out.',
  images: ['/demo/serum-1.svg', '/demo/serum-2.svg', '/demo/serum-3.svg'],
};

const fmt = (sec) => `0:${String(Math.max(0, Math.min(59, Math.floor(sec)))).padStart(2, '0')}`;
const slug = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'video';

function speakScript(text) {
  if (!text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  window.speechSynthesis.speak(u);
}

async function requestScript({name, price, badge, allowGrant}) {
  const res = await fetch(apiUrl('/api/script'), {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({name, price, badge}),
  });
  if (res.status === 403 && allowGrant && window.usernode && window.usernode.requestLlmAccess) {
    const granted = await window.usernode.requestLlmAccess();
    if (granted && granted.granted) return requestScript({name, price, badge, allowGrant: false});
    throw new Error('the AI grant was declined');
  }
  if (res.status === 503) throw new Error('AI script writing is unavailable here');
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'the AI daily cap is spent');
  }
  if (!res.ok) throw new Error('the writing service did not answer');
  const data = await res.json();
  if (!data.script) throw new Error('the script came back empty');
  return data.script;
}

const PlayIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M7 4l13 8-13 8z" /></svg>
);
const PauseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 5v14M16 5v14" /></svg>
);
const DownloadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
);
const SpeakerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6" /></svg>
);
const CrossIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const PlusIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);

function App() {
  const [images, setImages] = useState([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [badge, setBadge] = useState('');
  const [script, setScript] = useState('');
  const [scriptStatus, setScriptStatus] = useState('idle'); // idle | loading | error
  const [scriptError, setScriptError] = useState('');
  const [hasPreview, setHasPreview] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMsg, setExportMsg] = useState(''); // failure or cancel line
  const [canExport, setCanExport] = useState('pending'); // pending | h264 | vp9 | none
  const [previewNote, setPreviewNote] = useState('');
  const [demo, setDemo] = useState(false);

  const playerRef = useRef(null);
  const fileRef = useRef(null);
  const exportAbort = useRef(null);
  const noteTimer = useRef(null);

  const canGenerate = name.trim() && price.trim() && images.length > 0;
  const words = script.split(/\s+/).filter(Boolean).length;
  const speechSeconds = words ? Math.max(1, Math.round(words / 2.5)) : 0;
  const tooLong = speechSeconds > DURATION;
  const layout = timelineLayout(images.length || 1);
  const writing = scriptStatus === 'loading';

  // Where the video's images, price and script stand right now — the Player
  // re-renders on every change, so edits show straight away.
  const videoProps = {
    images: images.map((i) => i.src),
    price: price.trim(),
    badge: badge.trim(),
    script,
  };

  useEffect(() => {
    pickVideoCodec(VIDEO_WIDTH, VIDEO_HEIGHT, FPS).then(setCanExport);
    fetch(apiUrl('/api/config'), {headers: apiHeaders()})
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg && cfg.staging && new URLSearchParams(window.location.search).get('demo') === '1') {
          setDemo(true);
          setName(DEMO.name);
          setPrice(DEMO.price);
          setBadge(DEMO.badge);
          setScript(DEMO.script);
          setImages(DEMO.images.map((src, i) => ({id: 'demo-' + i, src})));
          setHasPreview(true);
          setTimeout(() => {
            if (playerRef.current) playerRef.current.seekTo(DEMO_FRAME);
          }, 500);
        }
      })
      .catch(() => {});
  }, []);

  // Player events: keep the timeline playhead honest, stop the reading voice
  // when playback stops.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return undefined;
    const onFrame = (e) => setFrame(e.detail.frame);
    const onStop = () => {
      setPlaying(false);
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('pause', onStop);
    p.addEventListener('ended', onStop);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('pause', onStop);
      p.removeEventListener('ended', onStop);
    };
  }, [hasPreview]);

  const addImageFiles = useCallback((files) => {
    const picks = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (!picks.length) return;
    setImages((cur) => {
      const room = MAX_IMAGES - cur.length;
      const added = picks.slice(0, room).map((f, i) => ({id: `up-${Date.now()}-${i}`, src: URL.createObjectURL(f)}));
      return cur.concat(added);
    });
  }, []);

  const addImageDataUrls = useCallback((urls) => {
    setImages((cur) => {
      const room = MAX_IMAGES - cur.length;
      return cur.concat(urls.slice(0, room).map((src, i) => ({id: `lk-${Date.now()}-${i}`, src})));
    });
  }, []);

  const removeImage = (id) => {
    setImages((cur) => {
      const hit = cur.find((i) => i.id === id);
      if (hit && hit.src.startsWith('blob:')) URL.revokeObjectURL(hit.src);
      const next = cur.filter((i) => i.id !== id);
      return next;
    });
  };

  // Removing the last image returns to the empty state.
  useEffect(() => {
    if (!images.length) {
      setHasPreview(false);
      setPlaying(false);
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
  }, [images.length]);

  async function generate() {
    if (!canGenerate || writing) return;
    setScriptStatus('loading');
    setScriptError('');
    let scriptText = '';
    try {
      scriptText = await requestScript({name: name.trim(), price: price.trim(), badge: badge.trim(), allowGrant: true});
      setScript(scriptText);
      setScriptStatus('idle');
    } catch (err) {
      setScriptError(err.message || 'writing the script failed');
      setScriptStatus('error');
    }
    // The preview builds either way, with whatever script is typed; the
    // playhead stays where the viewer left it.
    setHasPreview(true);
    if (scriptText) {
      setPreviewNote('Preview updated.');
      if (noteTimer.current) clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => setPreviewNote(''), 4000);
    }
  }

  async function fillFromLink() {
    const url = linkUrl.trim();
    if (!url || linkLoading) return;
    setLinkLoading(true);
    setLinkError('');
    try {
      const res = await fetch(apiUrl('/api/link'), {method: 'POST', headers: apiHeaders(), body: JSON.stringify({url})});
      if (!res.ok) throw new Error('unreadable');
      const data = await res.json();
      if (data.name) setName(data.name);
      if (data.price) setPrice(data.price);
      if (data.images && data.images.length) addImageDataUrls(data.images);
    } catch {
      setLinkError("Couldn't read that page. Try uploading images instead.");
    }
    setLinkLoading(false);
  }

  function togglePlay() {
    const p = playerRef.current;
    if (!p || !hasPreview) return;
    if (playing) {
      p.pause();
    } else {
      p.play();
      setPlaying(true);
      speakScript(script);
    }
  }

  function hearIt() {
    if (!script || writing) return;
    speakScript(script);
  }

  function seekFromTimeline(e) {
    const p = playerRef.current;
    if (!p || !hasPreview) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    p.seekTo(Math.round(frac * DURATION_FRAMES));
    setFrame(Math.round(frac * DURATION_FRAMES));
  }

  async function doExport() {
    if (!hasPreview || exporting || canExport === 'none' || canExport === 'pending') return;
    if (playing) togglePlay();
    setExporting(true);
    setExportProgress(0);
    setExportMsg('');
    const ctrl = new AbortController();
    exportAbort.current = ctrl;
    try {
      const blob = await exportMp4({
        composition: {id: 'promo', width: VIDEO_WIDTH, height: VIDEO_HEIGHT, fps: FPS, durationInFrames: DURATION_FRAMES},
        inputProps: videoProps,
        videoCodec: canExport,
        signal: ctrl.signal,
        onProgress: setExportProgress,
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tekotek-${slug(name)}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      if (err && err.name === 'AbortError') setExportMsg('Export cancelled.');
      else setExportMsg("Couldn't finish the export. Your inputs are untouched — try again.");
    }
    setExporting(false);
    exportAbort.current = null;
  }

  // ── markup, following the drawn screen ─────────────────────────────────
  const buttonCls = (primary) => (primary ? 'btn-primary' : 'btn-secondary');

  return (
    <>
      {demo ? <div className="small" data-usernode-demo-note style={{margin: '0 4px 4px'}}>Staging demo</div> : null}
      <div className="top">
        <div>
          <div className="t">Tekotek Studio</div>
          <div className="small">{name ? `${name}, 15 s` : '15 s'}</div>
        </div>
        <div className="small">9:16</div>
      </div>

      <div className="stage">
        <div className="phone">
          {hasPreview && images.length ? (
            <Player
              ref={playerRef}
              component={PromoVideo}
              inputProps={videoProps}
              durationInFrames={DURATION_FRAMES}
              compositionWidth={VIDEO_WIDTH}
              compositionHeight={VIDEO_HEIGHT}
              fps={FPS}
              style={{width: '100%', height: '100%'}}
              acknowledgeRemotionLicense
            />
          ) : (
            <div
              className="state-empty"
              style={{position: 'absolute', inset: 0, justifyContent: 'center', background: 'rgb(var(--raised))'}}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--muted))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h3l2 11h10l2-8H7" /><circle cx="9" cy="20" r="1" /><circle cx="17" cy="20" r="1" /></svg>
              <div className="small">Add product images</div>
              <button className="btn-primary" onClick={() => fileRef.current.click()}>Add images</button>
            </div>
          )}
        </div>

        <div className="side">
          <div className="small">
            {hasPreview
              ? `Preview at ${fmt(frame / FPS)}. The cart pops in near the end.`
              : 'Fill in the product, then Generate preview.'}
          </div>
          <button className="btn-secondary" onClick={togglePlay} disabled={!hasPreview}>
            {playing ? <PauseIcon /> : <PlayIcon />}
            {playing ? 'Pause' : 'Play preview'}
          </button>
          <button className={buttonCls(Boolean(canGenerate))} onClick={generate} disabled={!canGenerate || writing}>
            {writing ? 'Writing script' : 'Generate preview'}
          </button>
          <button className="btn-secondary" onClick={doExport} disabled={!hasPreview || exporting || canExport === 'none' || canExport === 'pending'}>
            <DownloadIcon />
            Export MP4
          </button>
          {previewNote ? <div className="small">Preview updated.</div> : null}
          {exporting ? (
            <div className="small" style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <span>Exporting… {Math.round(exportProgress * 100)}%</span>
              <button className="btn-secondary" style={{minHeight: 36, padding: '0 10px', fontSize: 14}} onClick={() => exportAbort.current && exportAbort.current.abort()}>
                Cancel
              </button>
            </div>
          ) : null}
          {!exporting && exportMsg ? (
            <div className="small" style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <span>{exportMsg}</span>
              <button className="btn-secondary" style={{minHeight: 36, padding: '0 10px', fontSize: 14}} onClick={doExport}>
                Retry
              </button>
            </div>
          ) : null}
          {canExport === 'none' && hasPreview ? <div className="small">Export needs a recent Chrome, Edge or Safari.</div> : null}
        </div>
      </div>

      <div className="tl">
        <div className="row" style={{justifyContent: 'space-between'}}>
          <b>Timeline</b>
          <span className="small">{fmt(frame / FPS)} / {fmt(DURATION)}</span>
        </div>
        <div className="track" onClick={seekFromTimeline} role="button" aria-label="Jump to a moment in the video" style={{cursor: hasPreview ? 'pointer' : 'default'}}>
          {layout.images.map((seg, i) => (
            <div key={i} style={{flex: seg.end - seg.start, background: i % 2 ? 'rgb(60 60 60)' : undefined, border: '1px solid rgb(var(--line))'}}>
              Image {i + 1}
            </div>
          ))}
          <div style={{flex: layout.cart.end - layout.cart.start, background: 'rgb(var(--cart))', color: 'rgb(var(--ink))'}}>Cart</div>
          <span className="head" style={{left: `${(frame / DURATION_FRAMES) * 100}%`}}></span>
        </div>
        <div className="over">
          <div style={{flex: layout.badge.start}}></div>
          <div style={{flex: layout.badge.end - layout.badge.start, background: 'rgb(var(--accent))', color: 'rgb(var(--on-accent))'}}>Price badge</div>
        </div>
        <div className="small">Voiceover runs the whole clip</div>
      </div>

      <div className="section-label">Product link</div>
      <div className="row">
        <input
          className="field"
          type="url"
          placeholder="Paste a product link"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && fillFromLink()}
        />
        <button className="btn-secondary" style={{flex: 'none'}} onClick={fillFromLink} disabled={linkLoading || !linkUrl.trim()}>
          {linkLoading ? 'Reading…' : 'Fill in'}
        </button>
      </div>
      {linkError ? <div className="small" style={{margin: '6px 4px 0', color: 'rgb(var(--danger))'}}>{linkError}</div> : null}

      <div className="section-label">Product images</div>
      <div className="thumbs">
        {images.map((img) => (
          <div key={img.id} className="th">
            <img src={img.src} alt="" style={{width: '100%', height: '100%', objectFit: 'cover', borderRadius: 7}} />
            <button className="x" aria-label="Remove image" onClick={() => removeImage(img.id)}>
              <CrossIcon />
            </button>
          </div>
        ))}
        {images.length < MAX_IMAGES ? (
          <button className="th add" aria-label="Add images" onClick={() => fileRef.current.click()}>
            <PlusIcon />
          </button>
        ) : null}
      </div>
      {images.length ? <div className="small" style={{margin: '8px 4px 0'}}>{images.length} of up to {MAX_IMAGES} images, shown in this order</div> : null}
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addImageFiles(e.target.files); e.target.value = ''; }} />

      <div className="section-label">Product details</div>
      <div className="lbl">Product name</div>
      <input className="field" style={{marginBottom: 8}} type="text" placeholder="e.g. Glow Serum 30ml" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="row">
        <div>
          <div className="lbl">Price</div>
          <input className="field" type="text" placeholder="e.g. $18.90" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div>
          <div className="lbl">Badge text</div>
          <input className="field" type="text" placeholder="e.g. Today only" value={badge} onChange={(e) => setBadge(e.target.value)} />
        </div>
      </div>

      <div className="section-label">Voiceover script</div>
      <div className="small" style={{margin: '0 4px 8px'}}>Written for you from the product details. Edit it freely.</div>
      {scriptStatus === 'loading' ? (
        <div className="field script" style={{display: 'block'}}>
          <div className="skeleton" style={{height: 14, width: '92%', marginBottom: 10}} />
          <div className="skeleton" style={{height: 14, width: '84%', marginBottom: 10}} />
          <div className="skeleton" style={{height: 14, width: '60%'}} />
        </div>
      ) : (
        <>
          {scriptStatus === 'error' ? (
            <div className="small" style={{margin: '0 4px 6px', color: 'rgb(var(--danger))'}}>
              Couldn't write a script: {scriptError}. The preview and typing your own still work.{' '}
              <button className="btn-secondary" style={{minHeight: 32, padding: '0 10px', fontSize: 14, display: 'inline-flex'}} onClick={generate}>Retry</button>
            </div>
          ) : null}
          <textarea className="field script" placeholder="e.g. Meet Glow Serum. One drop a day. Tap the yellow cart." value={script} onChange={(e) => setScript(e.target.value)} />
        </>
      )}
      <div className="small" style={{margin: '8px 4px 0'}}>
        {words ? `${words} words, about ${speechSeconds} seconds${tooLong ? ` — over ${DURATION} seconds, shorten it to fit` : ''}` : 'No script yet'}
      </div>
      <div className="row" style={{marginTop: 8, marginBottom: 12}}>
        <button className="btn-secondary" style={{flex: 1}} onClick={generate} disabled={!canGenerate || writing}>Rewrite</button>
        <button className="btn-secondary" style={{flex: 1}} onClick={hearIt} disabled={!script || writing}>
          <SpeakerIcon />
          Hear it
        </button>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);