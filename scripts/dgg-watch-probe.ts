/**
 * What the room would see if it were watching a destiny.gg embed right now.
 *
 *   npx tsx scripts/dgg-watch-probe.ts kick destiny
 *
 * It opens the same two sockets the API opens, with the same modules, and
 * prints what they say every ten seconds. Nothing is written to the database
 * and no settings are read from it, so this answers "is the tracker working"
 * without involving the room at all.
 *
 * The two counts are meant to differ: the site counts embeds open, the chat
 * roster counts people in chat with that embed selected. A channel nobody is
 * watching is absent from the site's list entirely, which reads as "not listed"
 * below.
 *
 * Nothing here needs DATABASE_URL, a session, or a key.
 */

import { ChatTracker, type WatchedChannel } from '../src/server/dgg-chat';
import { EmbedsTracker } from '../src/server/dgg-embeds';
import { watchPlatforms, type WatchPlatform } from '../src/shared/contracts';

const REPORT_MS = 10_000;

function readChannel(): WatchedChannel {
  const [platform, id] = process.argv.slice(2);
  if (!platform || !id) {
    throw new Error('Usage: npx tsx scripts/dgg-watch-probe.ts <platform> <channel>');
  }
  if (!watchPlatforms.includes(platform as WatchPlatform)) {
    throw new Error(`Platform must be one of ${watchPlatforms.join(', ')}`);
  }
  return { platform: platform as WatchPlatform, id: id.toLowerCase() };
}

const channel = readChannel();
const embeds = new EmbedsTracker();
const chat = new ChatTracker(channel);

embeds.start();
chat.start();
console.log(`Watching ${channel.platform}/${channel.id}. Ctrl-C to stop.`);

const timer = setInterval(() => {
  const entry = embeds.entryFor(channel);
  const watchers = chat.watchers();
  const named = watchers
    .slice(0, 8)
    .map((watcher) => watcher.nick)
    .join(', ');

  console.log(
    [
      new Date().toISOString(),
      entry ? `site ${entry.count}` : 'not listed',
      `chat ${watchers.length}`,
      `sockets live=${embeds.state().connected} chat=${chat.state().connected}`,
      named ? `· ${named}${watchers.length > 8 ? ' …' : ''}` : '',
    ].join(' · '),
  );
}, REPORT_MS);

function stop(): void {
  clearInterval(timer);
  embeds.stop();
  chat.stop();
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
