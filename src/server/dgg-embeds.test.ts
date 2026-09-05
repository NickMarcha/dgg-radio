import { describe, expect, it } from 'vitest';
import { findEmbed, parseEmbedsFrame } from './dgg-embeds';

/** Recorded from wss://live.destiny.gg/ on 2026-09-05, trimmed to two entries. */
const EMBEDS = `{"type":"dggApi:embeds","data":[{"platform":"kick","id":"destiny","count":707,"mediaItem":{"identifier":{"platform":"kick","mediaId":"destiny"},"metadata":{"previewUrl":"https://images.kick.com/video_thumbnails/0PMYoN0I2p4i/xDR5PennajOZ/480.webp","displayName":"Destiny","title":"memein' and streamin'","createdDate":"2026-09-05T15:06:14+00:00","live":true,"viewers":2822}}},{"platform":"kick","id":"drt0123","count":6,"mediaItem":{"identifier":{"platform":"kick","mediaId":"drt0123"},"metadata":{"previewUrl":"https://images.kick.com/video_thumbnails/YpMTDVbnMQ3K/jGKCLklCd4l1/480.webp","displayName":"drt0123","title":"Vids and Ask Me Anything :)","createdDate":"2026-09-05T13:49:09+00:00","live":true,"viewers":10}}}]}`;

const STREAM_INFO = `{"type":"dggApi:streamInfo","data":{"streams":{"twitch":null,"kick":{"live":true,"id":"destiny"}}},"cacheable":true}`;

describe('parseEmbedsFrame', () => {
  it('reads the embed list, with the site count and the platform’s own viewers', () => {
    const entries = parseEmbedsFrame(EMBEDS);
    expect(entries).toHaveLength(2);
    expect(entries?.[0]).toMatchObject({
      platform: 'kick',
      id: 'destiny',
      count: 707,
      displayName: 'Destiny',
      viewers: 2822,
    });
  });

  it('ignores every other message the socket sends', () => {
    expect(parseEmbedsFrame(STREAM_INFO)).toBeNull();
    expect(parseEmbedsFrame('not json at all')).toBeNull();
  });
});

describe('findEmbed', () => {
  const entries = parseEmbedsFrame(EMBEDS) ?? [];

  it('finds a channel however it is capitalised', () => {
    expect(findEmbed(entries, { platform: 'kick', id: 'destiny' })?.count).toBe(707);
  });

  it('answers null for a channel the site is not listing', () => {
    // The list only carries embeds somebody has open, so absence is the normal
    // state for a channel nobody is watching rather than an error.
    expect(findEmbed(entries, { platform: 'kick', id: 'dggjams' })).toBeNull();
    expect(findEmbed(entries, { platform: 'youtube', id: 'destiny' })).toBeNull();
  });
});
