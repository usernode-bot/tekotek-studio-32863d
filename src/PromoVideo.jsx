// The 15-second composition. Everything the preview plays and the MP4 export
// renders goes through this one component, so what you see is what exports.
//
// The video keeps ONE fixed look in both themes, because it is what gets
// exported: black frame, product photo, pink badge, yellow cart. Its colours
// are the spec's token values (light column), not CSS variables.
import React from 'react';
import {AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

export const FPS = 30;
export const DURATION = 15; // seconds
export const DURATION_FRAMES = DURATION * FPS; // 450
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920; // 9:16

export const IMAGE_SPAN = 11; // seconds the images play before the cart joins
export const BADGE_AT = 2; // seconds the price badge springs in
export const CART_AT = 11; // seconds the cart pops in
export const CAPTION_SPAN = 14; // seconds captions run across

const PINK = 'rgb(219 39 119)';
const YELLOW = 'rgb(254 204 0)';
const INK = 'rgb(18 18 18)';
const WHITE = 'rgb(255 255 255)';

// The timing helper the app's timeline strip also draws from.
export function timelineLayout(imageCount) {
  const n = Math.max(imageCount, 1);
  const per = IMAGE_SPAN / n;
  return {
    seconds: DURATION,
    images: Array.from({length: n}, (_, i) => ({
      label: `Image ${i + 1}`,
      start: i * per,
      end: (i + 1) * per,
    })),
    badge: {start: BADGE_AT, end: DURATION},
    cart: {label: 'Cart', start: CART_AT, end: DURATION},
  };
}

// Captions show one sentence at a time, timed by word count across 0..14 s.
export function captionTrack(script) {
  const sentences = String(script || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const counts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return [];
  let acc = 0;
  return sentences.map((text, i) => {
    const start = (acc / total) * CAPTION_SPAN;
    acc += counts[i];
    return {text, start, end: (acc / total) * CAPTION_SPAN};
  });
}

function CartIcon({size}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h3l2 11h10l2-8H7" />
      <circle cx="9" cy="20" r="1" />
      <circle cx="17" cy="20" r="1" />
    </svg>
  );
}

function FingerIcon({size}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={WHITE} stroke={INK} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11h-9V8a2 2 0 0 0-4 0v8l-2-2a2 2 0 0 0-3 3l4 4h9a3 3 0 0 0 3-3v-1h2a2 2 0 0 0 0-4z" />
      <path d="M13 15h4" />
    </svg>
  );
}

export const PromoVideo = ({images, price, badge, script}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const sec = frame / fps;

  // Images split 0..11 s evenly, each with a slow zoom.
  const list = images && images.length ? images : [''];
  const n = list.length;
  const per = IMAGE_SPAN / n;
  const idx = Math.min(Math.floor(sec / per), n - 1);
  const local = Math.min(Math.max((sec - idx * per) / per, 0), 1);
  const zoom = 1 + 0.08 * local;

  // Badge springs in at 2 s.
  const badgeIn = spring({frame: frame - BADGE_AT * fps, fps, config: {damping: 12, stiffness: 160, mass: 0.8}});

  // Cart pops in at 11 s with a bounce; the finger loops a tap towards it.
  const cartIn = spring({frame: frame - CART_AT * fps, fps, config: {damping: 7, stiffness: 170, mass: 0.9}});
  const tap = frame >= CART_AT * fps ? Math.abs(Math.sin((frame - CART_AT * fps) * (Math.PI / 14))) : 0;

  const caption = captionTrack(script).find((c) => sec >= c.start && sec < c.end);

  return (
    <AbsoluteFill style={{backgroundColor: INK}}>
      <AbsoluteFill>
        <Img src={list[idx]} style={{width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`}} />
      </AbsoluteFill>

      {price ? (
        <div
          style={{
            position: 'absolute',
            left: 64,
            top: 880,
            transform: `rotate(-6deg) scale(${interpolate(badgeIn, [0, 1], [0.2, 1])})`,
            opacity: badgeIn,
            transformOrigin: 'left center',
            background: PINK,
            color: WHITE,
            borderRadius: 40,
            padding: '12px 56px',
            fontWeight: 800,
            fontSize: 120,
            lineHeight: 1.25,
            textAlign: 'center',
          }}
        >
          {badge ? <span style={{display: 'block', fontSize: 60, fontWeight: 700, lineHeight: 1.3}}>{badge}</span> : null}
          {price}
        </div>
      ) : null}

      {caption ? (
        <div
          style={{
            position: 'absolute',
            left: 48,
            right: 48,
            bottom: 470,
            color: WHITE,
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.3,
            textAlign: 'center',
            textShadow: '0 2px 14px rgb(0 0 0 / 0.65)',
          }}
        >
          {caption.text}
        </div>
      ) : null}

      {frame >= CART_AT * fps ? (
        <>
          <div
            style={{
              position: 'absolute',
              right: 64,
              bottom: 100,
              width: 224,
              height: 224,
              borderRadius: '50%',
              background: YELLOW,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `-10px 10px 0 ${PINK}`,
              transform: `scale(${interpolate(cartIn, [0, 1], [0, 1])})`,
            }}
          >
            <CartIcon size={124} />
          </div>
          <div style={{position: 'absolute', right: 300, bottom: 140, transform: `translateY(${-34 * tap}px) rotate(-20deg)`}}>
            <FingerIcon size={120} />
          </div>
        </>
      ) : null}
    </AbsoluteFill>
  );
};