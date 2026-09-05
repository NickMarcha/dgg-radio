import { describe, expect, it } from 'vitest';
import { parseChatFrame, WatcherRoster, type WatchedChannel } from './dgg-chat';

/**
 * Every frame below was recorded from wss://chat.destiny.gg/ws on 2026-09-05
 * and trimmed to the users it needs. Nothing here is invented, so a change in
 * the real payload shape shows up as a failing test rather than as an overlay
 * that quietly names nobody.
 */
const NAMES = `NAMES {"users":[{"id":149440,"nick":"TheResized","roles":[],"features":[],"createdDate":"2022-04-04T17:35:40Z","watching":{"platform":"kick","id":"destiny"},"subscription":null},{"id":194202,"nick":"Spank","roles":[],"features":[],"createdDate":"2023-12-15T22:06:09Z","watching":{"platform":"kick","id":"destiny"},"subscription":null},{"id":65146,"nick":"Zatheerak","roles":[],"features":[],"createdDate":"2016-11-02T01:31:55Z","watching":{"platform":"youtube","id":"MeEuTKCtDF0"},"subscription":null},{"id":156213,"nick":"MVTT","roles":[],"features":[],"createdDate":"2022-06-29T22:48:59Z","watching":null,"subscription":null}],"connectioncount":2364}`;

const MSG = `MSG {"id":198010,"nick":"anpan","roles":[],"features":["flair13","subscriber"],"createdDate":"2024-04-25T23:26:50Z","watching":{"platform":"kick","id":"destiny"},"subscription":{"tier":1,"source":"destiny.gg"},"timestamp":1788623391472,"data":"Strumpling VeryPog"}`;

const JOIN_ELSEWHERE = `JOIN {"id":208507,"nick":"railort","roles":[],"features":[],"createdDate":"2024-11-05T03:35:34Z","watching":{"platform":"kick","id":"gemzar"},"subscription":null,"timestamp":1788623398212}`;

const QUIT = `QUIT {"id":149440,"nick":"TheResized","roles":[],"features":[],"createdDate":"2022-04-04T17:35:40Z","watching":{"platform":"kick","id":"destiny"},"subscription":null,"timestamp":1788623394212}`;

const KICK_DESTINY: WatchedChannel = { platform: 'kick', id: 'destiny' };

function rosterFrom(...raw: string[]): WatcherRoster {
  const roster = new WatcherRoster(KICK_DESTINY);
  for (const frame of raw) {
    const parsed = parseChatFrame(frame);
    if (parsed) roster.apply(parsed);
  }
  return roster;
}

describe('parseChatFrame', () => {
  it('splits the golang service’s "EVENT {json}" format', () => {
    expect(parseChatFrame(MSG)?.event).toBe('MSG');
    expect((parseChatFrame(MSG)?.data as { nick: string }).nick).toBe('anpan');
  });

  it('reads a payload that is not an object', () => {
    expect(parseChatFrame('ME null')).toEqual({ event: 'ME', data: null });
  });

  it('keeps a payload that is not JSON as text rather than failing', () => {
    expect(parseChatFrame('ERR duplicate')).toEqual({ event: 'ERR', data: 'duplicate' });
  });
});

describe('WatcherRoster', () => {
  it('counts only the people watching the tracked channel', () => {
    const roster = rosterFrom(NAMES);
    expect(roster.list().map((watcher) => watcher.nick)).toEqual(['Spank', 'TheResized']);
  });

  it('matches the channel however it is capitalised', () => {
    const roster = new WatcherRoster({ platform: 'kick', id: 'dggjams' });
    roster.apply({
      event: 'JOIN',
      data: { nick: 'someone', features: [], watching: { platform: 'kick', id: 'dggJams' } },
    });
    expect(roster.size()).toBe(1);
  });

  it('colours a name from the features chat sends', () => {
    const roster = rosterFrom(MSG);
    // flair13 is declared after subscriber upstream, so it is the one that wins.
    expect(roster.list()[0]).toMatchObject({ nick: 'anpan', flair: 'flair13', subTier: 1 });
  });

  it('takes the time somebody spoke from the message itself', () => {
    const roster = rosterFrom(MSG);
    expect(roster.list()[0].lastSpokeAt).toBe(new Date(1788623391472).toISOString());
  });

  it('ignores somebody joining while watching a different channel', () => {
    expect(rosterFrom(JOIN_ELSEWHERE).size()).toBe(0);
  });

  it('drops somebody whose message shows they have switched away', () => {
    const roster = rosterFrom(NAMES);
    roster.apply({
      event: 'MSG',
      data: {
        nick: 'TheResized',
        features: [],
        watching: { platform: 'kick', id: 'gemzar' },
        timestamp: 1788623400000,
      },
    });
    expect(roster.list().map((watcher) => watcher.nick)).toEqual(['Spank']);
  });

  it('removes somebody who quits', () => {
    const roster = rosterFrom(NAMES, QUIT);
    expect(roster.list().map((watcher) => watcher.nick)).toEqual(['Spank']);
  });

  it('applies both halves of a batched presence change', () => {
    const roster = rosterFrom(NAMES);
    roster.apply({
      event: 'USERSDELTA',
      data: {
        users: [{ nick: 'newcomer', features: [], watching: { platform: 'kick', id: 'destiny' } }],
        removed: [{ nick: 'Spank' }],
      },
    });
    expect(roster.list().map((watcher) => watcher.nick).sort()).toEqual([
      'TheResized',
      'newcomer',
    ]);
  });

  it('keeps who has been speaking when a reconnect rebuilds the roster', () => {
    const roster = rosterFrom(MSG);
    const spokeAt = roster.list()[0].lastSpokeAt;

    roster.apply({
      event: 'NAMES',
      data: {
        users: [{ nick: 'anpan', features: [], watching: { platform: 'kick', id: 'destiny' } }],
      },
    });

    expect(roster.list()[0].lastSpokeAt).toBe(spokeAt);
  });

  it('reads the backlog chat sends on connect, so an overlay starts populated', () => {
    const roster = rosterFrom(`HISTORY ${JSON.stringify([MSG])}`);
    expect(roster.list()[0]).toMatchObject({ nick: 'anpan' });
  });

  it('starts again when the tracked channel changes, and says that it did', () => {
    const roster = rosterFrom(NAMES);
    // The caller reconnects on a true, because NAMES only arrives on connect
    // and an empty roster otherwise refills one message at a time.
    expect(roster.watch({ platform: 'kick', id: 'dggjams' })).toBe(true);
    expect(roster.size()).toBe(0);
  });

  it('keeps the roster when told to watch the channel it already watches', () => {
    const roster = rosterFrom(NAMES);
    expect(roster.watch({ platform: 'kick', id: 'destiny' })).toBe(false);
    expect(roster.size()).toBe(2);
  });

  it('remembers the emote somebody used', () => {
    const roster = new WatcherRoster(KICK_DESTINY, (text) =>
      text.includes('catJAM') ? 'catJAM' : null,
    );
    const message = parseChatFrame(MSG.replace('Strumpling VeryPog', 'this one catJAM'));
    roster.apply(message!);
    expect(roster.list()[0].lastEmote).toBe('catJAM');
  });

  it('keeps that emote through their next message of plain words', () => {
    // Otherwise an overlay would flick back to the stand-in the moment somebody
    // says something ordinary, which is most of what anybody says.
    const roster = new WatcherRoster(KICK_DESTINY, (text) =>
      text.includes('catJAM') ? 'catJAM' : null,
    );
    roster.apply(parseChatFrame(MSG.replace('Strumpling VeryPog', 'this one catJAM'))!);
    roster.apply(parseChatFrame(MSG.replace('Strumpling VeryPog', 'what is this song'))!);
    expect(roster.list()[0].lastEmote).toBe('catJAM');
  });

  it('keeps it through a reconnect as well', () => {
    const roster = new WatcherRoster(KICK_DESTINY, () => 'catJAM');
    roster.apply(parseChatFrame(MSG)!);
    roster.apply({
      event: 'NAMES',
      data: {
        users: [{ nick: 'anpan', features: [], watching: { platform: 'kick', id: 'destiny' } }],
      },
    });
    expect(roster.list()[0].lastEmote).toBe('catJAM');
  });

  it('has no emote for somebody who has only ever been listed', () => {
    expect(rosterFrom(NAMES).list()[0].lastEmote).toBeNull();
  });

  it('leaves the roster alone for an event it does not know', () => {
    const roster = rosterFrom(NAMES);
    roster.apply({ event: 'BROADCAST', data: { data: 'Server restarting' } });
    expect(roster.size()).toBe(2);
  });
});
