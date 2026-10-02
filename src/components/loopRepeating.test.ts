import { describe, expect, it } from 'vitest';
import { loopRepeatingAnimations } from './loopRepeating';

/** An animation as the browser reports it, with only the timing that matters. */
function animation(iterations: number) {
  const timing = { iterations };
  return {
    timing,
    effect: {
      getTiming: () => ({ ...timing }),
      updateTiming: (change: { iterations: number }) => Object.assign(timing, change),
    },
  };
}

function emoteWith(animations: ReturnType<typeof animation>[]) {
  const asked: unknown[] = [];
  const element = {
    getAnimations: (options?: unknown) => {
      asked.push(options);
      return animations;
    },
  } as unknown as Element;
  return { element, asked };
}

describe('loopRepeatingAnimations', () => {
  it('loops what upstream repeats and leaves what runs once', () => {
    const dance = animation(16);
    const entrance = animation(1);
    const { element } = emoteWith([dance, entrance]);

    loopRepeatingAnimations(element);

    expect(dance.timing.iterations).toBe(Infinity);
    expect(entrance.timing.iterations).toBe(1);
  });

  it('asks for the pseudo-element decorations too', () => {
    const { element, asked } = emoteWith([]);
    loopRepeatingAnimations(element);
    expect(asked).toEqual([{ subtree: true }]);
  });

  it('leaves an animation that already never ends as it is', () => {
    const forever = animation(Infinity);
    loopRepeatingAnimations(emoteWith([forever]).element);
    expect(forever.timing.iterations).toBe(Infinity);
  });
});
