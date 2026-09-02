import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../shared/contracts';
import { moveItem } from './reorder';

function item(id: string): QueueItem {
  return {
    id,
    media: {
      id: `media-${id}`,
      provider: 'youtube',
      providerMediaId: id,
      providerArtistId: `channel-${id}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      title: `Track ${id}`,
      artist: 'Artist',
      durationSeconds: 120,
      thumbnailUrl: null,
    },
    requestedBy: null,
    status: 'queued',
    requestedAt: new Date(0).toISOString(),
    startedAt: null,
    upvotes: 0,
    downvotes: 0,
    myVote: 0,
  };
}

describe('queue movement controls', () => {
  const queue = [item('a'), item('b'), item('c')];

  it('moves a track one step or straight to an edge', () => {
    expect(moveItem(queue, 'c', 'up')).toEqual(['a', 'c', 'b']);
    expect(moveItem(queue, 'c', 'top')).toEqual(['c', 'a', 'b']);
    expect(moveItem(queue, 'a', 'down')).toEqual(['b', 'a', 'c']);
    expect(moveItem(queue, 'a', 'bottom')).toEqual(['b', 'c', 'a']);
  });

  it("keeps the current DJ's next turn locked at the bottom", () => {
    expect(moveItem(queue, 'a', 'bottom', 'c')).toEqual(['b', 'a', 'c']);
    expect(moveItem(queue, 'c', 'top', 'c')).toBeNull();
  });
});
